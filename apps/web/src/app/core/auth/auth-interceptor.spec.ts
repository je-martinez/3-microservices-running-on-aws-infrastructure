import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { authInterceptor } from './auth-interceptor';
import { StoredTokens, TokenStore } from './token-store';

const TOKENS: StoredTokens = {
  idToken: 'id-token-value',
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
};

/** Stands in for the real store so the specs exercise routing, not WebCrypto. */
class FakeTokenStore implements Pick<TokenStore, 'read'> {
  constructor(private readonly tokens: StoredTokens | null) {}
  read(): Promise<StoredTokens | null> {
    return Promise.resolve(this.tokens);
  }
}

/** Every path the interceptor must NOT authenticate, per the Users contract. */
const PUBLIC_URLS = [
  '/v1/users/login',
  '/v1/users/register',
  '/v1/users/register/passwordless',
  '/v1/users/refresh',
  '/v1/users/otp/start',
  '/v1/users/otp/verify',
  '/v1/users/password/forgot',
  '/v1/users/password/confirm',
];

function configure(tokens: StoredTokens | null): {
  http: HttpClient;
  controller: HttpTestingController;
} {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([authInterceptor])),
      provideHttpClientTesting(),
      { provide: TokenStore, useValue: new FakeTokenStore(tokens) },
    ],
  });
  return {
    http: TestBed.inject(HttpClient),
    controller: TestBed.inject(HttpTestingController),
  };
}

describe('authInterceptor', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    TestBed.resetTestingModule();
  });

  describe('with a stored session', () => {
    for (const url of ['/v1/users/me', '/v1/products', '/v1/cart']) {
      it(`attaches the access token to ${url}`, async () => {
        const { http, controller } = configure(TOKENS);

        http.get(url).subscribe();
        // The token read is async, so the request is only issued a microtask later.
        await Promise.resolve();

        const request = controller.expectOne(url);
        expect(request.request.headers.get('Authorization')).toBe(
          `Bearer ${TOKENS.accessToken}`,
        );
        request.flush({});
      });
    }

    it('sends the accessToken, never the idToken', async () => {
      const { http, controller } = configure(TOKENS);

      http.get('/v1/users/me').subscribe();
      await Promise.resolve();

      const request = controller.expectOne('/v1/users/me');
      expect(request.request.headers.get('Authorization')).not.toContain(TOKENS.idToken);
      request.flush({});
    });

    for (const url of PUBLIC_URLS) {
      it(`leaves ${url} unauthenticated`, async () => {
        const { http, controller } = configure(TOKENS);

        http.post(url, {}).subscribe();
        await Promise.resolve();

        const request = controller.expectOne(url);
        expect(request.request.headers.has('Authorization')).toBe(false);
        request.flush({});
      });
    }

    // The trap in the public list: this one IS the signed-in password change.
    it('authenticates /v1/users/me/password despite the password/* siblings being public', async () => {
      const { http, controller } = configure(TOKENS);

      http.post('/v1/users/me/password', {}).subscribe();
      await Promise.resolve();

      const request = controller.expectOne('/v1/users/me/password');
      expect(request.request.headers.get('Authorization')).toBe(`Bearer ${TOKENS.accessToken}`);
      request.flush({});
    });

    it('matches the exact path, so a query string does not defeat the public list', async () => {
      const { http, controller } = configure(TOKENS);

      http.get('/v1/users/login', { params: { next: '/orders' } }).subscribe();
      await Promise.resolve();

      const request = controller.expectOne((r) => r.url === '/v1/users/login');
      expect(request.request.headers.has('Authorization')).toBe(false);
      request.flush({});
    });

    it('leaves a non-gateway URL untouched', async () => {
      const { http, controller } = configure(TOKENS);

      http.get('/assets/config.json').subscribe();
      await Promise.resolve();

      const request = controller.expectOne('/assets/config.json');
      expect(request.request.headers.has('Authorization')).toBe(false);
      request.flush({});
    });
  });

  describe('with no stored session', () => {
    it('sends a protected request bare rather than throwing', async () => {
      const { http, controller } = configure(null);
      const onError = vi.fn();

      http.get('/v1/products').subscribe({ error: onError });
      await Promise.resolve();

      const request = controller.expectOne('/v1/products');
      expect(request.request.headers.has('Authorization')).toBe(false);
      request.flush({});
      expect(onError).not.toHaveBeenCalled();
    });
  });
});
