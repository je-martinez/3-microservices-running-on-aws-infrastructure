import type { AuthProvider, RefreshedTokens } from "#shared/auth/auth-provider";

export interface RefreshInput {
  refreshToken: string;
}

// Constructor-injected from the Awilix cradle (PROXY injection mode).
export class RefreshTokenCommand {
  private readonly auth: AuthProvider;

  constructor({ auth }: { auth: AuthProvider }) {
    this.auth = auth;
  }

  async execute(input: RefreshInput): Promise<RefreshedTokens> {
    return this.auth.refresh(input.refreshToken);
  }
}
