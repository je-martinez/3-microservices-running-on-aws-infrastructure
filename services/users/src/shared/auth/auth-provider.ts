export interface AuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

export interface CognitoSignUpResult {
  sub: string;
  email: string;
  emailVerified?: string;
  userPoolId: string;
  clientId: string;
}

export interface RefreshedTokens {
  idToken: string;
  accessToken: string;
}

export interface AuthProvider {
  // `fullName` is written to Cognito's standard `name` attribute, NOT because
  // this service needs it there — it has the name in Postgres — but because the
  // OTP challenge Lambda does. That trigger runs inside Cognito with zero
  // dependencies (no AWS SDK, no database), so the only user data it can read is
  // what Cognito itself stores. Without this the login-code email greets every
  // recipient namelessly, and no amount of work in this service can fix it from
  // the outside. See infra/modules/cognito/otp-challenge-lambda/index.mjs.
  signUp(
    email: string,
    password: string,
    appUserId: string,
    fullName: string,
  ): Promise<CognitoSignUpResult>;
  login(email: string, password: string): Promise<AuthTokens>;
  refresh(refreshToken: string): Promise<RefreshedTokens>;
  // Cognito CUSTOM_AUTH, used for the one-time-code login path. `session` is the
  // opaque challenge handle the caller must hand back with the code; it is
  // credential-adjacent (it is what buys tokens) and is never logged.
  startOtpChallenge(email: string): Promise<{ session: string }>;
  respondToOtpChallenge(email: string, session: string, code: string): Promise<AuthTokens>;
  // Sets a permanent password for an existing account, administratively — the
  // caller has ALREADY been authorized by the time this runs (a verified reset
  // code, or an authenticated /me request). This is deliberately NOT Cognito's
  // ForgotPassword/ConfirmForgotPassword pair: that flow mints and emails its
  // own code, never returns it to the caller, and rejects any code this service
  // minted (`CodeMismatchException`) — verified empirically, including a control
  // invocation proving the probe itself worked. Owning the whole reset flow means
  // owning the final write too.
  //
  // Throws InvalidCredentialsError when the account does not exist, so an
  // unknown email cannot be distinguished from a wrong code by status alone.
  setPassword(email: string, newPassword: string): Promise<void>;
  // Mirrors `users.must_change_password` onto the Cognito account, where the
  // Pre-Token-Generation trigger can read it into the `must_change_password`
  // token claim. Postgres stays the source of truth; this is a projection of it.
  //
  // It exists because that trigger runs inside Cognito with no database access
  // (same constraint that puts `name` on the account for the OTP Lambda), so a
  // value the token must carry has to be pushed to Cognito by whoever changes it.
  //
  // Callers treat this as BEST-EFFORT and must not fail the request on it: the
  // durable write to Postgres has already happened by then, and `GET /v1/users/me`
  // — the frontend's existing source for this flag — reads that column, not the
  // token. A failure here means the claim is stale until the next token is
  // issued, not that the flag was lost.
  setMustChangePassword(email: string, mustChangePassword: boolean): Promise<void>;

  // Removes the Cognito account outright (AdminDeleteUser). This is what FREES
  // THE EMAIL ADDRESS, which is the entire point of the delete-account flow: a
  // user who deletes their account must be able to register again with the same
  // address later.
  //
  // Deliberately NOT AdminDisableUser. A disabled account keeps occupying its
  // email in the pool, so a returning user would hit UsernameExistsException
  // forever — the requirement would be unimplementable.
  //
  // This departs from the letter of [[ADR-0004-soft-delete-only]] narrowly and on
  // purpose: that rule governs our DATABASES (whose write users hold no DELETE
  // grant), and the durable record of the user IS preserved there — a soft-deleted
  // row keeping its real email. Cognito is an external identity provider, not our
  // database, and the sub it holds is a credential rather than a record.
  //
  // Throws InvalidCredentialsError when the account does not exist, like every
  // other method here: an unknown account must not be distinguishable from any
  // other failure by error type alone.
  deleteUser(email: string): Promise<void>;
}
