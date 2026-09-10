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
  // CONTRACT: Write `fullName` to Cognito's `name` attribute. The OTP challenge
  // Lambda runs inside Cognito with no SDK and no database, so this is the only user
  // data it can read — without it the login-code email greets every recipient
  // namelessly, and nothing in this service can fix that from the outside.
  signUp(
    email: string,
    password: string,
    appUserId: string,
    fullName: string,
  ): Promise<CognitoSignUpResult>;
  login(email: string, password: string): Promise<AuthTokens>;
  refresh(refreshToken: string): Promise<RefreshedTokens>;
  // Cognito CUSTOM_AUTH, for the one-time-code login path.
  // WARNING: `session` is credential-adjacent — it is what buys tokens. Never log it.
  startOtpChallenge(email: string): Promise<{ session: string }>;
  respondToOtpChallenge(email: string, session: string, code: string): Promise<AuthTokens>;
  // CONTRACT: Do NOT reach for Cognito's ForgotPassword/ConfirmForgotPassword pair —
  // it mints and emails its own code, never returns it, and rejects any code this
  // service minted (`CodeMismatchException`). The caller is already authorized when
  // this runs. Throws InvalidCredentialsError for a missing account, so an unknown
  // email is indistinguishable from a wrong code.
  setPassword(email: string, newPassword: string): Promise<void>;
  // CONTRACT: Best-effort — callers must NOT fail the request on it. Postgres is the
  // source of truth and its write has already happened; a failure here only leaves
  // the token claim stale until the next token is issued. It exists because the
  // Pre-Token-Generation trigger runs inside Cognito with no database access, so a
  // value the token must carry has to be pushed there by whoever changes it.
  setMustChangePassword(email: string, mustChangePassword: boolean): Promise<void>;

  // CONTRACT: Takes an ACCESS token, not an id or refresh token, and the token itself
  // is the only authorization — no pool id, no client id, no IAM policy is evaluated.
  // It must carry the `aws.cognito.signin.user.admin` scope, which tokens minted by
  // AdminInitiateAuth do; a hosted-UI token without that scope is rejected.
  // WARNING: The token is a credential. Never log it, on a span or anywhere else.
  // Resolves for an already-invalid token so signing out twice is not an error.
  signOut(accessToken: string): Promise<void>;

  // CONTRACT: AdminDeleteUser, NOT AdminDisableUser — deleting is what frees the
  // email address, and a disabled account keeps occupying it so a returning user hits
  // UsernameExistsException forever. A narrow, deliberate departure from
  // [[ADR-0004-soft-delete-only]]: that rule governs our databases, where the
  // soft-deleted row still holds the real email; Cognito is an external identity
  // provider. Throws InvalidCredentialsError for a missing account, like the rest.
  deleteUser(email: string): Promise<void>;
}
