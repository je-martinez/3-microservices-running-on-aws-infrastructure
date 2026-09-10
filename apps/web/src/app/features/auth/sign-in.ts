import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { UsersApi } from '../../core/api/users-api';
import { SessionStore } from '../../core/auth/session-store';
import { StoredTokens, TokenStore } from '../../core/auth/token-store';

/**
 * The one path from "Users returned tokens" to "the app is signed in".
 *
 * CONTRACT: Persist BEFORE calling /users/me. authInterceptor reads the token
 * from TokenStore, so a profile fetch issued first goes out bare and Users
 * answers 404 — which reads as a missing account, not a missing header.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
@Injectable({ providedIn: 'root' })
export class SignIn {
  private readonly usersApi = inject(UsersApi);
  private readonly tokenStore = inject(TokenStore);
  private readonly sessionStore = inject(SessionStore);
  private readonly router = inject(Router);

  /**
   * Stores the tokens, loads the profile and lands the user.
   * `mustChangePassword` accounts go to /password/new: Users clears that flag
   * only through the password endpoints, so letting them into the app leaves
   * them one reload away from being sent back anyway.
   */
  async complete(tokens: StoredTokens): Promise<void> {
    await this.tokenStore.write(tokens);
    const user = await firstValueFrom(this.usersApi.me());
    this.sessionStore.setUser(user);
    await this.router.navigateByUrl(user.mustChangePassword ? '/password/new' : '/');
  }
}
