export interface AuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

export interface AuthProvider {
  signUp(email: string, password: string): Promise<{ sub: string }>;
  login(email: string, password: string): Promise<AuthTokens>;
}
