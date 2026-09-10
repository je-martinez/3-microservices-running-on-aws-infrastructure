import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { UsersApi } from '../api/users-api';
import { SessionRehydration } from './session-rehydration';
import { SessionStore } from './session-store';

/**
 * Fills SessionStore from GET /users/me after a session is restored on boot.
 *
 * CONTRACT: Rehydration establishes only that tokens EXIST; it leaves
 * `SessionStore.user` null. The JWT carries no address, tags, authType or audit
 * fields, so the profile cannot be decoded from it — it must be fetched. Skip
 * this and routing works after a reload while the header, account menu and
 * profile screen all render an empty user.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
@Injectable({ providedIn: 'root' })
export class ProfileLoader {
  private readonly rehydration = inject(SessionRehydration);
  private readonly usersApi = inject(UsersApi);
  private readonly sessionStore = inject(SessionStore);

  /**
   * Resolves once the profile is loaded, or at once when no session exists.
   *
   * CONTRACT: Do NOT rethrow here. A rejected app initializer aborts bootstrap
   * and strands the boot loader over a dead page — an unreachable Users service
   * must cost the profile chrome, not the whole app.
   * See [[2026-09-04-web-gateway-integration-design]]
   */
  async loadIfSignedIn(): Promise<void> {
    if (!(await this.rehydration.whenSettled())) return;
    try {
      this.sessionStore.setUser(await firstValueFrom(this.usersApi.me()));
    } catch {
      return;
    }
  }
}

/** The `provideAppInitializer` body; runs after `rehydrateSession`. */
export function loadRestoredProfile(): Promise<void> {
  return inject(ProfileLoader).loadIfSignedIn();
}
