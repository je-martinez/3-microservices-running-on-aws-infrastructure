import { Injectable, inject, signal } from '@angular/core';

import { TokenStore } from './token-store';

/**
 * Restores the persisted session on boot, before the router resolves a route.
 *
 * CONTRACT: `whenSettled()` is the ONLY way to learn whether a session exists.
 * The TokenStore read decrypts from IndexedDB and is therefore async, so any
 * caller that inspects session state synchronously on first paint sees "signed
 * out" for a valid session — a reload on /orders redirects to /login while
 * in-app navigation works, which is why the bug survives a navigation-only test.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
@Injectable({ providedIn: 'root' })
export class SessionRehydration {
  private readonly tokenStore = inject(TokenStore);

  private readonly restored = signal(false);
  private readonly settled = signal(false);
  private inFlight: Promise<boolean> | null = null;

  /** True once a stored token has been found; meaningless until `settled()`. */
  readonly hasStoredSession = this.restored.asReadonly();

  /** True once the boot read has finished, whatever it found. */
  readonly isSettled = this.settled.asReadonly();

  /**
   * Resolves to whether a persisted session was found. Memoised: the boot step
   * and every guard consulted during that first navigation share one read
   * rather than each decrypting the record again.
   */
  whenSettled(): Promise<boolean> {
    this.inFlight ??= this.read();
    return this.inFlight;
  }

  /**
   * Marks the session as established without re-reading storage, for a caller
   * that has just written new tokens (sign-in) or dropped them (sign-out).
   */
  markRestored(hasSession: boolean): void {
    this.restored.set(hasSession);
    this.settled.set(true);
    this.inFlight = Promise.resolve(hasSession);
  }

  private async read(): Promise<boolean> {
    // WHY: no try/catch — TokenStore.read() resolves null on a missing, corrupt
    // or unreadable record rather than throwing, so boot cannot be bricked here.
    const tokens = await this.tokenStore.read();
    const hasSession = tokens !== null;
    this.restored.set(hasSession);
    this.settled.set(true);
    return hasSession;
  }
}

/**
 * The `provideAppInitializer` body: Angular waits on this before the first
 * navigation, so no guard runs against an unread store.
 */
// WHY: blocking boot costs nothing visible — index.html paints the brand loader
// until `afterNextRender` dismisses it, so the decrypt happens behind it.
export function rehydrateSession(): Promise<boolean> {
  return inject(SessionRehydration).whenSettled();
}
