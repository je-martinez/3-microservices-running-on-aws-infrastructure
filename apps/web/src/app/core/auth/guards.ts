import { inject } from '@angular/core';
import { CanActivateFn, GuardResult, Router } from '@angular/router';

import { SessionRehydration } from './session-rehydration';
import { SessionStore } from './session-store';

/**
 * Whether a session exists as far as routing is concerned.
 *
 * CONTRACT: Await rehydration; never decide on `isAuthenticated` alone. The
 * stored token is decrypted asynchronously, so on a cold start the in-memory
 * session is still empty when the first guard runs — deciding there evicts a
 * valid user on every reload, while in-app navigation stays green and hides it.
 * See [[2026-09-04-web-gateway-integration-design]]
 *
 * CONTRACT: Both injects happen before the first `await`. `inject()` outside an
 * injection context throws NG0203, and awaiting first leaves that context.
 */
function hasSession(): Promise<boolean> {
  const session = inject(SessionStore);
  const rehydration = inject(SessionRehydration);

  // A user who signed in during this page's lifetime is authenticated whatever
  // storage says; the stored token covers only the reload case.
  if (session.isAuthenticated()) return Promise.resolve(true);
  return rehydration.whenSettled();
}

/** Guards every signed-in page. An anonymous visitor is sent to /login. */
export const authGuard: CanActivateFn = (): Promise<GuardResult> => {
  const router = inject(Router);
  return hasSession().then((authenticated) => authenticated || router.parseUrl('/login'));
};

/** Guards the auth pages. A signed-in visitor has no business on /login. */
export const guestGuard: CanActivateFn = (): Promise<GuardResult> => {
  const router = inject(Router);
  return hasSession().then((authenticated) => !authenticated || router.parseUrl('/'));
};
