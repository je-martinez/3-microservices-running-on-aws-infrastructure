import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';

import { authInterceptor } from './auth-interceptor';
import { refreshInterceptor } from './refresh-interceptor';
import { SessionStore } from './session-store';
import { StoredTokens, TokenStore } from './token-store';

const TOKENS: StoredTokens = {
  idToken: 'id-token-v1',
  accessToken: 'access-token-v1',
  refreshToken: 'refresh-token-v1',
};

const REFRESHED = { accessToken: 'access-token-v2', idToken: 'id-token-v2' };

/** Stands in for the encrypted store so the specs exercise routing, not WebCrypto. */
class FakeTokenStore implements Pick<TokenStore, 'read' | 'write' | 'clear'> {
  tokens: StoredTokens | null = { ...TOKENS };
  cleared = 0;

  read(): Promise<StoredTokens | null> {
    return Promise.resolve(this.tokens);
  }
  write(tokens: StoredTokens): Promise<void> {
    this.tokens = tokens;
    return Promise.resolve();
  }
  clear(): Promise<void> {
    this.cleared += 1;
    this.tokens = null;
    return Promise.resolve();
  }
}

interface Harness {
  http: HttpClient;
  controller: HttpTestingController;
  tokenStore: FakeTokenStore;
  session: InstanceType<typeof SessionStore>;
  navigate: ReturnType<typeof vi.fn>;
}

function configure(): Harness {
  const tokenStore = new FakeTokenStore();
  const navigate = vi.fn().mockResolvedValue(true);

  TestBed.configureTestingModule({
    providers: [
      // The real registration order from app.config.ts: refresh first, so its
      // retry re-enters authInterceptor and picks up the refreshed token.
      provideHttpClient(withInterceptors([refreshInterceptor, authInterceptor])),
      provideHttpClientTesting(),
      { provide: TokenStore, useValue: tokenStore },
      { provide: Router, useValue: { navigateByUrl: navigate } },
    ],
  });

  return {
    http: TestBed.inject(HttpClient),
    controller: TestBed.inject(HttpTestingController),
    tokenStore,
    session: TestBed.inject(SessionStore),
    navigate,
  };
}

/**
 * Lets every pending microtask settle. The token read, the token write and the
 * router navigation are all async, so a spec that calls expectOne() straight
 * after subscribe() asserts before the request has been issued.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function refreshRequests(controller: HttpTestingController) {
  return controller.match('/v1/users/refresh');
}

describe('refreshInterceptor', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('refreshes once on a 401 and the retried request succeeds', async () => {
    const { http, controller, tokenStore } = configure();
    const onNext = vi.fn();

    http.get('/v1/users/me').subscribe({ next: onNext });
    await settle();

    controller.expectOne('/v1/users/me').flush({ error: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' });
    await settle();

    const refresh = refreshRequests(controller);
    expect(refresh).toHaveLength(1);
    expect(refresh[0].request.body).toEqual({ refreshToken: TOKENS.refreshToken });
    refresh[0].flush(REFRESHED);
    await settle();

    const retry = controller.expectOne('/v1/users/me');
    // The retry re-entered authInterceptor, so it carries the NEW access token.
    expect(retry.request.headers.get('Authorization')).toBe(`Bearer ${REFRESHED.accessToken}`);
    retry.flush({ id: 'user-1' });
    await settle();

    expect(onNext).toHaveBeenCalledWith({ id: 'user-1' });
    // The refreshToken is carried over: /users/refresh does not rotate it.
    expect(tokenStore.tokens).toEqual({
      accessToken: REFRESHED.accessToken,
      idToken: REFRESHED.idToken,
      refreshToken: TOKENS.refreshToken,
    });
    controller.verify();
  });

  /**
   * CONTRACT: This asserts the CALL COUNT, not that the five calls succeed —
   * five separate refreshes also make all five succeed, so a success-only
   * assertion passes with the single-flight guard deleted.
   */
  it('fires EXACTLY ONE refresh for five concurrent 401s', async () => {
    const { http, controller } = configure();
    const paths = ['/v1/users/me', '/v1/products', '/v1/cart', '/v1/orders', '/v1/orders/o-1'];
    const results = paths.map(() => vi.fn());

    paths.forEach((path, i) => http.get(path).subscribe({ next: results[i] }));
    await settle();

    for (const path of paths) {
      controller
        .expectOne(path)
        .flush({ error: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' });
    }
    await settle();

    const refresh = refreshRequests(controller);
    expect(refresh).toHaveLength(1);
    refresh[0].flush(REFRESHED);
    await settle();

    for (const [i, path] of paths.entries()) {
      const retry = controller.expectOne(path);
      expect(retry.request.headers.get('Authorization')).toBe(`Bearer ${REFRESHED.accessToken}`);
      retry.flush({ path });
      await settle();
      expect(results[i]).toHaveBeenCalledWith({ path });
    }

    // No second refresh was issued while the retries ran.
    expect(refreshRequests(controller)).toHaveLength(0);
    controller.verify();
  });

  it('allows a LATER 401 to refresh again once the first refresh has settled', async () => {
    const { http, controller } = configure();

    http.get('/v1/users/me').subscribe();
    await settle();
    controller
      .expectOne('/v1/users/me')
      .flush({ error: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' });
    await settle();
    refreshRequests(controller)[0].flush(REFRESHED);
    await settle();
    controller.expectOne('/v1/users/me').flush({ ok: true });
    await settle();

    // Second burst, after the single-flight has reset.
    const onNext = vi.fn();
    http.get('/v1/products').subscribe({ next: onNext });
    await settle();
    controller
      .expectOne('/v1/products')
      .flush({ error: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' });
    await settle();

    const second = refreshRequests(controller);
    expect(second).toHaveLength(1);
    expect(second[0].request.body).toEqual({ refreshToken: TOKENS.refreshToken });
    second[0].flush({ accessToken: 'access-token-v3', idToken: 'id-token-v3' });
    await settle();

    const retry = controller.expectOne('/v1/products');
    expect(retry.request.headers.get('Authorization')).toBe('Bearer access-token-v3');
    retry.flush({ ok: true });
    await settle();

    expect(onNext).toHaveBeenCalledWith({ ok: true });
    controller.verify();
  });

  it('clears the session, clears the tokens and redirects to /login when the refresh fails', async () => {
    const { http, controller, tokenStore, session, navigate } = configure();
    session.setUser({ id: 'user-1', email: 'a@b.c' } as never);
    const onError = vi.fn();

    http.get('/v1/users/me').subscribe({ error: onError });
    await settle();
    controller
      .expectOne('/v1/users/me')
      .flush({ error: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' });
    await settle();

    refreshRequests(controller)[0].flush(
      { error: 'Invalid refresh token' },
      { status: 401, statusText: 'Unauthorized' },
    );
    await settle();

    expect(session.isAuthenticated()).toBe(false);
    expect(tokenStore.cleared).toBe(1);
    expect(tokenStore.tokens).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/login');
    expect(onError).toHaveBeenCalled();
    controller.verify();
  });

  it('does not recurse when /v1/users/refresh itself answers 401', async () => {
    const { http, controller } = configure();
    const onError = vi.fn();

    http.post('/v1/users/refresh', { refreshToken: TOKENS.refreshToken }).subscribe({
      error: onError,
    });
    await settle();

    const request = controller.expectOne('/v1/users/refresh');
    request.flush({ error: 'Invalid refresh token' }, { status: 401, statusText: 'Unauthorized' });
    await settle();

    // No second /users/refresh: the public-path list short-circuits this call.
    expect(refreshRequests(controller)).toHaveLength(0);
    expect(onError).toHaveBeenCalled();
    controller.verify();
  });

  it('passes a 401 through untouched when no refresh token is stored', async () => {
    const { http, controller, tokenStore } = configure();
    tokenStore.tokens = null;
    const onError = vi.fn();

    http.get('/v1/users/me').subscribe({ error: onError });
    await settle();
    controller
      .expectOne('/v1/users/me')
      .flush({ error: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' });
    await settle();

    expect(refreshRequests(controller)).toHaveLength(0);
    expect(onError).toHaveBeenCalled();
    controller.verify();
  });

  for (const status of [403, 500]) {
    it(`passes a ${String(status)} straight through with no refresh attempted`, async () => {
      const { http, controller } = configure();
      const onError = vi.fn();

      http.get('/v1/users/me').subscribe({ error: onError });
      await settle();
      controller
        .expectOne('/v1/users/me')
        .flush({ error: 'nope' }, { status, statusText: 'Error' });
      await settle();

      expect(refreshRequests(controller)).toHaveLength(0);
      expect(onError).toHaveBeenCalled();
      controller.verify();
    });
  }
});
