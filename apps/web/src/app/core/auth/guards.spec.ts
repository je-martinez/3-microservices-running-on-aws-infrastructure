import { EnvironmentInjector, runInInjectionContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  CanActivateFn,
  GuardResult,
  Router,
  RouterStateSnapshot,
  UrlTree,
  provideRouter,
} from '@angular/router';

import { User } from '../api/types';
import { authGuard, guestGuard } from './guards';
import { SessionRehydration } from './session-rehydration';
import { SessionStore } from './session-store';
import { StoredTokens, TokenStore } from './token-store';

const TOKENS: StoredTokens = {
  idToken: 'id-token-value',
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
};

const USER = {
  id: 'user-1',
  email: 'jane@example.com',
  fullName: 'Jane Doe',
} as unknown as User;

/**
 * A token store whose read is held open until the spec releases it. This is the
 * whole point of the cold-start test: a guard that decides synchronously answers
 * before `release()` is ever called.
 */
class DeferredTokenStore implements Pick<TokenStore, 'read' | 'write' | 'clear'> {
  private resolveRead: ((tokens: StoredTokens | null) => void) | null = null;
  reads = 0;

  constructor(private readonly tokens: StoredTokens | null) {}

  read(): Promise<StoredTokens | null> {
    this.reads += 1;
    return new Promise((resolve) => (this.resolveRead = resolve));
  }

  /** Lets the pending read() settle with the tokens this store was built with. */
  release(): void {
    this.resolveRead?.(this.tokens);
  }

  write(): Promise<void> {
    return Promise.resolve();
  }
  clear(): Promise<void> {
    return Promise.resolve();
  }
}

/** Resolves immediately, for the cases that are not about boot ordering. */
class ImmediateTokenStore implements Pick<TokenStore, 'read' | 'write' | 'clear'> {
  constructor(private readonly tokens: StoredTokens | null) {}

  read(): Promise<StoredTokens | null> {
    return Promise.resolve(this.tokens);
  }
  write(): Promise<void> {
    return Promise.resolve();
  }
  clear(): Promise<void> {
    return Promise.resolve();
  }
}

function configure(tokenStore: Pick<TokenStore, 'read' | 'write' | 'clear'>): void {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: TokenStore, useValue: tokenStore }],
  });
}

/**
 * Runs a guard the way the router does: inside an injection context, with the
 * snapshot arguments it declares. Calling it bare throws NG0203 instead.
 */
function runGuard(guard: CanActivateFn): Promise<GuardResult> {
  const injector = TestBed.inject(EnvironmentInjector);
  const result = runInInjectionContext(injector, () =>
    guard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
  );
  return Promise.resolve(result as Promise<GuardResult>);
}

function isRedirectTo(result: GuardResult, path: string): boolean {
  return result instanceof UrlTree && TestBed.inject(Router).serializeUrl(result) === path;
}

describe('authGuard', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('allows an authenticated user', async () => {
    configure(new ImmediateTokenStore(TOKENS));
    TestBed.inject(SessionStore).setUser(USER);

    await expect(runGuard(authGuard)).resolves.toBe(true);
  });

  it('redirects an anonymous user to /login', async () => {
    configure(new ImmediateTokenStore(null));

    const result = await runGuard(authGuard);

    expect(isRedirectTo(result, '/login')).toBe(true);
  });

  /**
   * The reason this issue exists. In-app navigation never reproduces the bug —
   * only a reload does, because only then is the guard consulted while the
   * IndexedDB read is still in flight. Deciding on the empty session at that
   * moment redirects a perfectly valid user to /login.
   */
  it('allows a stored session when consulted BEFORE rehydration resolves', async () => {
    const tokenStore = new DeferredTokenStore(TOKENS);
    configure(tokenStore);

    // No user in SessionStore and no settled read: exactly the cold-start state.
    const session = TestBed.inject(SessionStore);
    const rehydration = TestBed.inject(SessionRehydration);
    expect(session.isAuthenticated()).toBe(false);
    expect(rehydration.isSettled()).toBe(false);

    const decision = runGuard(authGuard);
    // The guard must still be undecided here — it is waiting on the read.
    let settledEarly = false;
    void decision.then(() => (settledEarly = true));
    await Promise.resolve();
    expect(settledEarly).toBe(false);

    tokenStore.release();

    await expect(decision).resolves.toBe(true);
  });

  it('shares one token read across concurrent guard activations', async () => {
    const tokenStore = new DeferredTokenStore(TOKENS);
    configure(tokenStore);

    const first = runGuard(authGuard);
    const second = runGuard(authGuard);
    tokenStore.release();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(tokenStore.reads).toBe(1);
  });
});

describe('guestGuard', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('redirects an authenticated user away from /login', async () => {
    configure(new ImmediateTokenStore(TOKENS));
    TestBed.inject(SessionStore).setUser(USER);

    const result = await runGuard(guestGuard);

    expect(isRedirectTo(result, '/')).toBe(true);
  });

  it('lets an anonymous user through', async () => {
    configure(new ImmediateTokenStore(null));

    await expect(runGuard(guestGuard)).resolves.toBe(true);
  });

  it('redirects a stored session even before rehydration resolves', async () => {
    const tokenStore = new DeferredTokenStore(TOKENS);
    configure(tokenStore);

    const decision = runGuard(guestGuard);
    tokenStore.release();

    expect(isRedirectTo(await decision, '/')).toBe(true);
  });
});

describe('SessionRehydration', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('leaves the session empty and does not throw when no token is stored', async () => {
    configure(new ImmediateTokenStore(null));
    const rehydration = TestBed.inject(SessionRehydration);

    await expect(rehydration.whenSettled()).resolves.toBe(false);

    expect(rehydration.isSettled()).toBe(true);
    expect(rehydration.hasStoredSession()).toBe(false);
    expect(TestBed.inject(SessionStore).user()).toBeNull();
  });

  it('reports a stored session and settles', async () => {
    configure(new ImmediateTokenStore(TOKENS));
    const rehydration = TestBed.inject(SessionRehydration);

    await expect(rehydration.whenSettled()).resolves.toBe(true);

    expect(rehydration.hasStoredSession()).toBe(true);
  });

  it('takes markRestored as the answer without re-reading storage', async () => {
    const tokenStore = new ImmediateTokenStore(null);
    configure(tokenStore);
    const rehydration = TestBed.inject(SessionRehydration);

    rehydration.markRestored(true);

    expect(rehydration.isSettled()).toBe(true);
    await expect(rehydration.whenSettled()).resolves.toBe(true);
  });
});
