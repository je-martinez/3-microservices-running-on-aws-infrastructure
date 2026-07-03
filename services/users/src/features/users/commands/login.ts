import type { AuthProvider, AuthTokens } from "#shared/auth/auth-provider";

export interface LoginInput {
  email: string;
  password: string;
}

// Constructor-injected from the Awilix cradle (PROXY injection mode).
export class LoginUserCommand {
  private readonly auth: AuthProvider;

  constructor({ auth }: { auth: AuthProvider }) {
    this.auth = auth;
  }

  async execute(input: LoginInput): Promise<AuthTokens> {
    return this.auth.login(input.email, input.password);
  }
}
