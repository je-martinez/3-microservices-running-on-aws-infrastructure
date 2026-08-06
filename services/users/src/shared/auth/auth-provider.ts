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
  signUp(email: string, password: string, appUserId: string): Promise<CognitoSignUpResult>;
  login(email: string, password: string): Promise<AuthTokens>;
  refresh(refreshToken: string): Promise<RefreshedTokens>;
  // Cognito CUSTOM_AUTH, used for the one-time-code login path. `session` is the
  // opaque challenge handle the caller must hand back with the code; it is
  // credential-adjacent (it is what buys tokens) and is never logged.
  startOtpChallenge(email: string): Promise<{ session: string }>;
  respondToOtpChallenge(email: string, session: string, code: string): Promise<AuthTokens>;
}
