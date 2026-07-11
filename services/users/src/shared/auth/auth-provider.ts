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
  signUp(email: string, password: string): Promise<CognitoSignUpResult>;
  login(email: string, password: string): Promise<AuthTokens>;
  refresh(refreshToken: string): Promise<RefreshedTokens>;
}
