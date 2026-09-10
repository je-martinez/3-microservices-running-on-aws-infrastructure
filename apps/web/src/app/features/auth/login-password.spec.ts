import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { SessionStore } from '../../core/auth/session-store';
import { TokenStore } from '../../core/auth/token-store';
import { LoginPasswordPage } from './login-password';
import {
  AUTH_TEST_PROVIDERS,
  USER,
  awaitRequest,
  fillField,
  resetStorage,
  settle,
  submitForm,
  textOf,
} from './testing';

const TOKENS = { idToken: 'id', accessToken: 'access', refreshToken: 'refresh' };

describe('LoginPasswordPage', () => {
  let fixture: ComponentFixture<LoginPasswordPage>;
  let controller: HttpTestingController;

  beforeEach(async () => {
    resetStorage();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        ...AUTH_TEST_PROVIDERS,
      ],
    });
    await TestBed.compileComponents();
    controller = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(LoginPasswordPage);
    fixture.detectChanges();
  });

  afterEach(() => {
    controller.verify();
    TestBed.resetTestingModule();
  });

  it('persists the tokens and populates the session on a successful login', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);

    fillField(fixture, 'Email', 'jane@example.com');
    fillField(fixture, 'Password', 'hunter2!');
    submitForm(fixture);

    const login = await awaitRequest(fixture, controller, '/v1/users/login');
    expect(login.request.method).toBe('POST');
    expect(login.request.body).toEqual({ email: 'jane@example.com', password: 'hunter2!' });
    login.flush(TOKENS);

    (await awaitRequest(fixture, controller, '/v1/users/me')).flush(USER);
    await settle(fixture);

    await expect(TestBed.inject(TokenStore).read()).resolves.toEqual(TOKENS);
    expect(TestBed.inject(SessionStore).user()).toEqual(USER);
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('blocks a malformed email client-side, so no request leaves', async () => {
    fillField(fixture, 'Email', 'not-an-email');
    fillField(fixture, 'Password', 'hunter2!');
    submitForm(fixture);
    await settle(fixture);

    // controller.verify() in afterEach is the other half of this assertion.
    controller.expectNone('/v1/users/login');
    expect(textOf(fixture, '[role="alert"]')).toContain('valid email');
  });

  it('shows a credentials message on a 401 and does NOT navigate', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);

    fillField(fixture, 'Email', 'jane@example.com');
    fillField(fixture, 'Password', 'wrong');
    submitForm(fixture);

    (await awaitRequest(fixture, controller, '/v1/users/login')).flush(
      { error: 'Invalid credentials' },
      { status: 401, statusText: 'Unauthorized' },
    );
    await settle(fixture);

    expect(textOf(fixture, '[role="alert"]')).toContain('do not match an account');
    expect(navigate).not.toHaveBeenCalled();
    expect(TestBed.inject(SessionStore).isAuthenticated()).toBe(false);
    await expect(TestBed.inject(TokenStore).read()).resolves.toBeNull();
  });

  it('sends the user through /password/new when the account must change its password', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);

    fillField(fixture, 'Email', 'jane@example.com');
    fillField(fixture, 'Password', 'temporary');
    submitForm(fixture);

    (await awaitRequest(fixture, controller, '/v1/users/login')).flush(TOKENS);
    (await awaitRequest(fixture, controller, '/v1/users/me')).flush({
      ...USER,
      mustChangePassword: true,
    });
    await settle(fixture);

    expect(navigate).toHaveBeenCalledWith('/password/new');
  });
});
