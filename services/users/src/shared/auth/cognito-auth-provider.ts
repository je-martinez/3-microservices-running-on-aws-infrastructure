import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
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

  async signUp(
    email: string,
    password: string,
    appUserId: string,
    fullName: string,
  ): Promise<CognitoSignUpResult> {
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
            // Mirrors the `must_change_password` column's default for a new
            // row. Written inline rather than through setMustChangePassword()
            // so registration costs no extra Cognito round trip, and so the
            // attribute exists from the account's first token — the Lambda
            // treats a missing attribute as false anyway, but an explicit
            // value keeps the account state readable in the console.
            { Name: "custom:must_change_password", Value: "false" },
            // The standard OIDC `name` claim. Written for ONE consumer: the OTP
            // challenge Lambda, which greets the user in the login-code email
            // and can read nothing but Cognito's own attributes (see the port's
            // note in auth-provider.ts). This service reads the name from
            // Postgres, never from here.
            { Name: "name", Value: fullName },
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

  // The final write of the self-owned reset flow. `Permanent: true` matters: a
  // temporary password would put the account into FORCE_CHANGE_PASSWORD, and the
  // very next login would come back with a NEW_PASSWORD_REQUIRED challenge this
  // service has no path to answer — the user would be locked out by the act of
  // resetting their password. The "must change password" signal we DO want lives
  // in our own column (`users.must_change_password`), which the frontend reads,
  // not in Cognito's account status.
  //
  // Authorization is the CALLER's responsibility and has already happened: either
  // a reset code was verified against our store, or the request carried an
  // authenticated identity. Nothing about this method checks it.
  async setPassword(email: string, newPassword: string): Promise<void> {
    try {
      await this.client.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: this.userPoolId,
          Username: email,
          Password: newPassword,
          Permanent: true,
        }),
      );
    } catch (e: any) {
      // Mapped to the same 401 an unknown/failed credential gets, so this call
      // cannot be turned into an account-existence oracle by a caller who
      // somehow reaches it with an unknown email.
      if (e?.name === "UserNotFoundException") throw new InvalidCredentialsError();
      throw e;
    }
  }

  // Projects the `users.must_change_password` column onto the Cognito account so
  // the Pre-Token-Generation trigger can emit it as a claim (see the port's note
  // in auth-provider.ts). Cognito has no boolean attribute type, so the value is
  // the string "true"/"false" — matching what the Lambda compares against.
  //
  // Note this does NOT re-issue existing tokens: a token already in the user's
  // hands keeps the value it was minted with until it expires or is refreshed.
  // That is inherent to putting mutable state in a JWT and is why Postgres, read
  // through GET /v1/users/me, remains the authoritative answer.
  async setMustChangePassword(email: string, mustChangePassword: boolean): Promise<void> {
    try {
      await this.client.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: this.userPoolId,
          Username: email,
          UserAttributes: [
            { Name: "custom:must_change_password", Value: String(mustChangePassword) },
          ],
        }),
      );
    } catch (e: any) {
      // Same mapping as setPassword: an unknown account must not be
      // distinguishable from any other failure by the error type alone.
      if (e?.name === "UserNotFoundException") throw new InvalidCredentialsError();
      throw e;
    }
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
