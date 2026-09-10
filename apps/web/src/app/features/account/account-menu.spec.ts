import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { AccountMenu } from './account-menu';
import { SessionStore } from '../../core/auth/session-store';
import { TokenStore } from '../../core/auth/token-store';
import { USER, resetStorage, settle } from '../auth/testing';
import { SCREEN_TEST_PROVIDERS } from '../../shared/testing/fixtures';

describe('AccountMenu', () => {
  let fixture: ComponentFixture<AccountMenu>;

  beforeEach(async () => {
    resetStorage();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        ...SCREEN_TEST_PROVIDERS,
      ],
    });
    await TestBed.compileComponents();
    TestBed.inject(SessionStore).setUser(USER);
    fixture = TestBed.createComponent(AccountMenu);
    fixture.detectChanges();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  /**
   * CONTRACT: Signing out clears the session, the persisted tokens AND lands on
   * /login. Closing the overlay alone leaves the app rendering a signed-in
   * shell whose every call 401s.
   */
  it('tears the session down and lands on /login', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const tokenStore = TestBed.inject(TokenStore);
    await tokenStore.write({ accessToken: 'a', idToken: 'i', refreshToken: 'r' });

    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '[data-testid="account-sign-out"]',
    );
    if (!button) throw new Error('No sign-out button');
    button.click();
    await settle(fixture);

    // Sign-out revokes server-side before tearing down locally.
    TestBed.inject(HttpTestingController)
      .expectOne((r) => r.url.includes('/users/logout'))
      .flush(null, { status: 204, statusText: 'No Content' });
    await settle(fixture);

    expect(TestBed.inject(SessionStore).user()).toBeNull();
    expect(await tokenStore.read()).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/login');
  });
});
