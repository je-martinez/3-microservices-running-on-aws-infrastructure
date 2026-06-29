import type { AuthProvider, AuthTokens } from "../../../shared/auth/auth-provider.js";

export async function loginUser(
  deps: { auth: AuthProvider },
  input: { email: string; password: string },
): Promise<AuthTokens> {
  return deps.auth.login(input.email, input.password);
}
