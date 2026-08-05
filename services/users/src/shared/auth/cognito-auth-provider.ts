import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminInitiateAuthCommand,
  RespondToAuthChallengeCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import type { AuthProvider, AuthTokens, CognitoSignUpResult, RefreshedTokens } from "./auth-provider.ts";
import { InvalidCredentialsError, EmailAlreadyExistsError, InvalidOtpError } from "./auth-errors.ts";

export class CognitoAuthProvider implements AuthProvider {
  constructor(
    private readonly client: CognitoIdentityProviderClient,
    private readonly userPoolId: string,
    private readonly clientId: string,
  ) {}

  async signUp(email: string, password: string, appUserId: string): Promise<CognitoSignUpResult> {
    let created;
    try {
      created = await this.client.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: email,
          MessageAction: "SUPPRESS",
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
            { Name: "custom:app_user_id", Value: appUserId },
          ],
        }),
      );
    } catch (e: any) {
      if (e?.name === "UsernameExistsException") throw new EmailAlreadyExistsError();
      throw e;
    }
    await this.client.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: this.userPoolId,
        Username: email,
        Password: password,
        Permanent: true,
      }),
    );
    // A missing `sub` used to fall back to the email. That is a silent
    // corruption: the email would be hashed into the idempotency key as if it
    // were a sub. Fail loudly instead.
    const sub = created.User?.Attributes?.find((a) => a.Name === "sub")?.Value;
    if (!sub) throw new Error(`Cognito AdminCreateUser returned no sub for ${email}`);
    const emailVerified = created.User?.Attributes?.find((a) => a.Name === "email_verified")?.Value;
    return { sub, email, emailVerified, userPoolId: this.userPoolId, clientId: this.clientId };
  }

  async login(email: string, password: string): Promise<AuthTokens> {
    let res;
    try {
      res = await this.client.send(
        new AdminInitiateAuthCommand({
          UserPoolId: this.userPoolId,
          ClientId: this.clientId,
          AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
          AuthParameters: { USERNAME: email, PASSWORD: password },
        }),
      );
    } catch (e: any) {
      if (e?.name === "UserNotFoundException" || e?.name === "NotAuthorizedException") {
        throw new InvalidCredentialsError();
      }
      throw e;
    }
    const r = res.AuthenticationResult;
    return {
      idToken: r?.IdToken ?? "",
      accessToken: r?.AccessToken ?? "",
      refreshToken: r?.RefreshToken ?? "",
    };
  }

  // CUSTOM_AUTH, never USER_AUTH/EMAIL_OTP: the local emulator accepts the
  // native flow and returns tokens WITHOUT issuing a challenge at all, so a
  // caller who only knows an email would authenticate. CUSTOM_AUTH routes
  // through our own Define/Create/Verify triggers in both local and prod.
  async startOtpChallenge(email: string): Promise<{ session: string }> {
    let res;
    try {
      res = await this.client.send(
        new AdminInitiateAuthCommand({
          UserPoolId: this.userPoolId,
          ClientId: this.clientId,
          AuthFlow: "CUSTOM_AUTH",
          AuthParameters: { USERNAME: email },
        }),
      );
    } catch (e: any) {
      if (e?.name === "UserNotFoundException") throw new InvalidCredentialsError();
      throw e;
    }
    if (!res.Session) throw new Error(`CUSTOM_AUTH InitiateAuth returned no session for ${email}`);
    return { session: res.Session };
  }

  // RespondToAuthChallenge is the NON-admin call: it takes ClientId and no
  // UserPoolId, unlike every other method on this class.
  async respondToOtpChallenge(email: string, session: string, code: string): Promise<AuthTokens> {
    let res;
    try {
      res = await this.client.send(
        new RespondToAuthChallengeCommand({
          ClientId: this.clientId,
          ChallengeName: "CUSTOM_CHALLENGE",
          Session: session,
          ChallengeResponses: { USERNAME: email, ANSWER: code },
        }),
      );
    } catch (e: any) {
      if (e?.name === "NotAuthorizedException" || e?.name === "UserNotFoundException") {
        throw new InvalidOtpError();
      }
      throw e;
    }
    if (!res.AuthenticationResult) {
      // Cognito accepted the answer but the flow is not complete (e.g. it
      // returned a further challenge) — treated the same as an invalid code:
      // the caller gets no tokens either way, and this codebase has no
      // multi-step CUSTOM_AUTH beyond the single code challenge.
      throw new InvalidOtpError();
    }
    const r = res.AuthenticationResult;
    return {
      idToken: r.IdToken ?? "",
      accessToken: r.AccessToken ?? "",
      refreshToken: r.RefreshToken ?? "",
    };
  }

  async refresh(refreshToken: string): Promise<RefreshedTokens> {
    let res;
    try {
      res = await this.client.send(
        new AdminInitiateAuthCommand({
          UserPoolId: this.userPoolId,
          ClientId: this.clientId,
          AuthFlow: "REFRESH_TOKEN_AUTH",
          AuthParameters: { REFRESH_TOKEN: refreshToken },
        }),
      );
    } catch (e: any) {
      if (e?.name === "NotAuthorizedException" || e?.name === "UserNotFoundException") {
        throw new InvalidCredentialsError();
      }
      throw e;
    }
    const r = res.AuthenticationResult;
    return { idToken: r?.IdToken ?? "", accessToken: r?.AccessToken ?? "" };
  }
}
