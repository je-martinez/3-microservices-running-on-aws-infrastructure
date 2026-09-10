import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  AdminInitiateAuthCommand,
  GlobalSignOutCommand,
  RespondToAuthChallengeCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { context, propagation } from "@opentelemetry/api";
import { getLogContext } from "#shared/logging/log-context";
import type { AuthProvider, AuthTokens, CognitoSignUpResult, RefreshedTokens } from "./auth-provider.ts";
import { InvalidCredentialsError, EmailAlreadyExistsError, InvalidOtpError } from "./auth-errors.ts";


// CONTRACT: ClientMetadata is the seam that hands trace context DOWN to the Cognito
// CUSTOM_AUTH trigger — the only caller-controlled field Cognito forwards verbatim.
// That trigger publishes AUTH_OTP_REQUESTED but cannot inject a traceparent itself
// (Cognito invokes it, and it ships zero dependencies). Return UNDEFINED, never `{}`,
// when no span is active: an empty ClientMetadata sends a field with nothing usable.
// Unlike the SQS traceparent, this value survives to the wire unmodified.
// See [[logging-context]]
function traceContextMetadata(): Record<string, string> | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  // CONTRACT: Add the run id AFTER the inject, never gated behind it.
  // `propagation.inject` writes nothing without an active span, so returning early on
  // an empty carrier drops the run id whenever tracing is off — exactly the E2E
  // configuration where every OTP email would then land unattributed. Omitted, never
  // blank, like traceparent.
  const runId = getLogContext().run_id;
  if (runId) carrier.runId = runId;

  return Object.keys(carrier).length > 0 ? carrier : undefined;
}

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
    // CONTRACT: Do NOT fall back to email when Cognito returns no sub — the email
    // hashes into the idempotency key as if it were a sub (silent corruption). Throw.
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
          // Carries this request's trace down to the challenge trigger, which
          // publishes the OTP event and cannot obtain the context any other way.
          ClientMetadata: traceContextMetadata(),
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

  // CONTRACT: Keep `Permanent: true`. A temporary password puts the account into
  // FORCE_CHANGE_PASSWORD, so the next login returns a NEW_PASSWORD_REQUIRED
  // challenge this service cannot answer — the user is locked out by the act of
  // resetting their password. The "must change password" signal lives in our own
  // column, not Cognito's account status. Authorization is the CALLER's job and has
  // already happened; nothing here checks it.
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
      // CONTRACT: Map to the same 401 a failed credential gets, so this cannot become
      // an account-existence oracle for a caller reaching it with an unknown email.
      if (e?.name === "UserNotFoundException") throw new InvalidCredentialsError();
      throw e;
    }
  }

  // CONTRACT: Cognito has no boolean attribute type — the value is the STRING
  // "true"/"false" the Lambda compares against. This does not re-issue existing
  // tokens: one already in the user's hands keeps its minted value until refreshed,
  // which is why Postgres via GET /v1/users/me stays authoritative.
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

  // Removes the account from the pool, which is what frees the email address for
  // re-registration. See the port's note for why this is AdminDeleteUser and not
  // AdminDisableUser, and why deleting here does not contradict our
  // soft-delete-only rule for databases.
  async deleteUser(email: string): Promise<void> {
    try {
      await this.client.send(
        new AdminDeleteUserCommand({
          UserPoolId: this.userPoolId,
          Username: email,
        }),
      );
    } catch (e: any) {
      // Same mapping as setPassword and setMustChangePassword.
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

  // GlobalSignOut, NOT RevokeToken: RevokeToken kills only the refresh token and
  // leaves the access token usable until it expires on its own.
  // CONTRACT: Swallow NotAuthorizedException rather than mapping it to a 401 — Cognito
  // answers it for an expired, malformed or ALREADY revoked token, all of which mean
  // the session is gone, which is what the caller asked for. A 401 here fails the
  // second of two clicks for a client that already dropped its tokens.
  // See [[users-service-design]]
  async signOut(accessToken: string): Promise<void> {
    try {
      await this.client.send(new GlobalSignOutCommand({ AccessToken: accessToken }));
    } catch (e: any) {
      if (e?.name === "NotAuthorizedException" || e?.name === "UserNotFoundException") return;
      throw e;
    }
  }
}
