import { ChangeDetectionStrategy, Component, EnvironmentInjector, runInInjectionContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  GuardResult,
  Router,
  RouterStateSnapshot,
  provideRouter,
} from '@angular/router';
import { of, throwError } from 'rxjs';

import { UsersApi } from '../../core/api/users-api';
import { authGuard, guestGuard } from '../../core/auth/guards';
import { SessionRehydration } from '../../core/auth/session-rehydration';
import { SessionStore } from '../../core/auth/session-store';
import { StoredTokens, TokenStore } from '../../core/auth/token-store';
import { NotificationsSocket } from '../../core/notifications/notifications-socket';
import { SignOut } from './sign-out';
import { USER } from './testing';

const TOKENS: StoredTokens = {
  idToken: 'id-token-value',
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
};

@Component({ template: '', changeDetection: ChangeDetectionStrategy.OnPush })
class BlankPage {}

/** Stands in for the encrypted store so the specs exercise routing, not WebCrypto. */
class FakeTokenStore implements Pick<TokenStore, 'read' | 'write' | 'clear'> {
  constructor(public tokens: StoredTokens | null) {}

  read(): Promise<StoredTokens | null> {
    return Promise.resolve(this.tokens);
  }
  write(tokens: StoredTokens): Promise<void> {
    this.tokens = tokens;
    return Promise.resolve();
  }
  clear(): Promise<void> {
    this.tokens = null;
    return Promise.resolve();
  }
}

interface Harness {
  signOut: SignOut;
  router: Router;
  rehydration: SessionRehydration;
  session: InstanceType<typeof SessionStore>;
  tokenStore: FakeTokenStore;
  logout: ReturnType<typeof vi.fn>;
}

/**
 * WHY: the real router and the real guards, so the regression spec fails the
 * way the browser did — /login bounced to `/` — rather than on a stubbed call.
 */
function configure(logoutFails = false): Harness {
  const tokenStore = new FakeTokenStore({ ...TOKENS });
  const logout = vi.fn(() =>
    logoutFails ? throwError(() => new Error('revocation failed')) : of(undefined),
  );

  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: '', component: BlankPage, canActivate: [authGuard] },
        { path: 'login', component: BlankPage, canActivate: [guestGuard] },
      ]),
      { provide: TokenStore, useValue: tokenStore },
      { provide: UsersApi, useValue: { logout } },
      { provide: NotificationsSocket, useValue: { disconnect: vi.fn() } },
    ],
  });

  return {
    signOut: TestBed.inject(SignOut),
    router: TestBed.inject(Router),
    rehydration: TestBed.inject(SessionRehydration),
    session: TestBed.inject(SessionStore),
    tokenStore,
    logout,
  };
}

/** Runs a guard inside an injection context, as the router does. */
function runGuard(guard: typeof guestGuard): Promise<GuardResult> {
  const injector = TestBed.inject(EnvironmentInjector);
  const result = runInInjectionContext(injector, () =>
    guard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
  );
  return Promise.resolve(result as Promise<GuardResult>);
}

/** The cold-start state: a stored session read at boot, the user on `/`. */
async function bootSignedIn(harness: Harness): Promise<void> {
  await expect(harness.rehydration.whenSettled()).resolves.toBe(true);
  harness.session.setUser(USER);
  await harness.router.navigateByUrl('/');
  expect(harness.router.url).toBe('/');
}

async function expectSignedOut(harness: Harness): Promise<void> {
  expect(harness.session.isAuthenticated()).toBe(false);
  expect(harness.tokenStore.tokens).toBeNull();
  expect(harness.rehydration.hasStoredSession()).toBe(false);
  await expect(harness.rehydration.whenSettled()).resolves.toBe(false);
  expect(harness.router.url).toBe('/login');
}

describe('SignOut', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  describe('discard()', () => {
    it('settles rehydration as signed out and lands on /login', async () => {
      const harness = configure();
      await bootSignedIn(harness);

      await harness.signOut.discard();

      await expectSignedOut(harness);
      expect(harness.logout).not.toHaveBeenCalled();
    });

    it('settles rehydration before it navigates', async () => {
      const harness = configure();
      await bootSignedIn(harness);
      const atNavigation: { stored?: boolean; guest?: GuardResult } = {};
      vi.spyOn(harness.router, 'navigateByUrl').mockImplementation(async () => {
        atNavigation.stored = harness.rehydration.hasStoredSession();
        atNavigation.guest = await runGuard(guestGuard);
        return true;
      });

      await harness.signOut.discard();

      expect(atNavigation.stored).toBe(false);
      expect(atNavigation.guest).toBe(true);
    });
  });

  describe('complete()', () => {
    it('revokes, then ends signed out', async () => {
      const harness = configure();
      await bootSignedIn(harness);

      await harness.signOut.complete();

      expect(harness.logout).toHaveBeenCalledTimes(1);
      await expectSignedOut(harness);
    });

    it('ends signed out even when the revocation fails', async () => {
      const harness = configure(true);
      await bootSignedIn(harness);

      await harness.signOut.complete();

      await expectSignedOut(harness);
    });
  });
});

/**
 * Regression: a stored session the backend rejects at boot. The failed
 * refresh calls `discard()`, and guestGuard must let /login through instead of
 * answering from the memoised boot read and bouncing the user back to `/`.
 */
describe('guestGuard after a failed-refresh sign-out', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('lets /login through once discard() has run on a session restored at boot', async () => {
    const harness = configure();
    await bootSignedIn(harness);

    await harness.signOut.discard();

    await expect(runGuard(guestGuard)).resolves.toBe(true);
    expect(harness.router.url).toBe('/login');
  });
});
