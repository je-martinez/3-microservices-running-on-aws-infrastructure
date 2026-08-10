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
}
