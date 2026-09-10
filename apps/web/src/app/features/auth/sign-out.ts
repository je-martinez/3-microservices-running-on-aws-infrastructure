import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { UsersApi } from '../../core/api/users-api';
import { SessionStore } from '../../core/auth/session-store';
import { TokenStore } from '../../core/auth/token-store';

/**
 * The one path from "the app is signed in" to signed out.
 *
 * CONTRACT: The in-memory session, the persisted tokens and the URL all have to
 * agree. Clearing any subset leaves the app rendering a signed-in shell over
 * calls that all 401, or a login screen the guards bounce straight out of.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
@Injectable({ providedIn: 'root' })
export class SignOut {
  private readonly usersApi = inject(UsersApi);
  private readonly tokenStore = inject(TokenStore);
  private readonly sessionStore = inject(SessionStore);
  private readonly router = inject(Router);

  /**
   * CONTRACT: Revoke FIRST, then clear — clearing first sends the call out bare.
   * A failed revocation must NOT block the teardown: a signed-in shell the user
   * cannot leave is worse than a server session that expires on its own.
   */
  async complete(): Promise<void> {
    try {
      await firstValueFrom(this.usersApi.logout());
    } catch {
      // Swallowed on purpose — see the CONTRACT above.
    }
    await this.discard();
  }

  /**
   * CONTRACT: Tears the session down WITHOUT calling the server. For a caller
   * whose token is already known-bad — a failed refresh — the revocation is a
   * request guaranteed to fail, and awaiting it only delays the redirect.
   */
  async discard(): Promise<void> {
    this.sessionStore.clear();
    await this.tokenStore.clear();
    await this.router.navigateByUrl('/login');
  }
}
