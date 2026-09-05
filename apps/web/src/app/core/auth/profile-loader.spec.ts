import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ProfileLoader } from './profile-loader';
import { SessionRehydration } from './session-rehydration';
import { SessionStore } from './session-store';
import { TokenStore } from './token-store';
import { resetStorage, USER } from '../../features/auth/testing';

const TOKENS = { idToken: 'id', accessToken: 'access', refreshToken: 'refresh' };

describe('ProfileLoader', () => {
  let controller: HttpTestingController;

  beforeEach(() => {
    resetStorage();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify();
    TestBed.resetTestingModule();
  });

  /**
   * CONTRACT: Rehydration proves only that TOKENS exist — it leaves
   * SessionStore.user null, because the JWT carries no address, tags, authType
   * or audit fields. This is the assertion that the profile is actually
   * fetched; without it a reload leaves the header and profile blank while
   * routing works. See [[2026-09-04-web-gateway-integration-design]]
   */
  it('loads the profile into SessionStore after a restored session', async () => {
    await TestBed.inject(TokenStore).write(TOKENS);
    const session = TestBed.inject(SessionStore);
    expect(session.user()).toBeNull();

    const loading = TestBed.inject(ProfileLoader).loadIfSignedIn();

    const request = await waitForMe();
    expect(request.request.method).toBe('GET');
    request.flush(USER);
    await loading;

    expect(session.user()).toEqual(USER);
    expect(session.isAuthenticated()).toBe(true);
  });

  it('makes no request when no session was restored', async () => {
    await TestBed.inject(ProfileLoader).loadIfSignedIn();

    controller.expectNone('/v1/users/me');
    expect(TestBed.inject(SessionStore).user()).toBeNull();
  });

  /**
   * WHY: a rejected app initializer aborts bootstrap and strands the boot
   * loader over a dead page. An unreachable Users service costs the profile
   * chrome, not the whole app.
   */
  it('resolves without throwing when the profile call fails', async () => {
    await TestBed.inject(TokenStore).write(TOKENS);

    const loading = TestBed.inject(ProfileLoader).loadIfSignedIn();
    (await waitForMe()).flush({ message: 'boom' }, { status: 500, statusText: 'Server Error' });

    await expect(loading).resolves.toBeUndefined();
    expect(TestBed.inject(SessionStore).user()).toBeNull();
  });

  /**
   * CONTRACT: Exactly ONE GET /users/me per boot. `whenSettled()` is memoised,
   * so the loader shares the boot read instead of re-decrypting; a second call
   * here would mean every guard consulted during first navigation triggers its
   * own profile request.
   */
  it('issues a single profile request across boot and the loader', async () => {
    await TestBed.inject(TokenStore).write(TOKENS);
    await TestBed.inject(SessionRehydration).whenSettled();

    const loading = TestBed.inject(ProfileLoader).loadIfSignedIn();
    (await waitForMe()).flush(USER);
    await loading;

    controller.expectNone('/v1/users/me');
    expect(TestBed.inject(SessionStore).user()).toEqual(USER);
  });

  /** Pumps macrotasks until the IndexedDB read releases the /users/me call. */
  async function waitForMe() {
    for (let turn = 0; turn < 25; turn += 1) {
      const [request] = controller.match('/v1/users/me');
      if (request) return request;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('No request for /v1/users/me');
  }
});
