import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminInitiateAuthCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import type { AuthProvider, AuthTokens, CognitoSignUpResult, RefreshedTokens } from "./auth-provider.ts";
import { InvalidCredentialsError, EmailAlreadyExistsError } from "./auth-errors.ts";

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
