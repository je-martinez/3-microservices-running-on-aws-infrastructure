import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { UsersApi } from './users-api';

describe('UsersApi', () => {
  let usersApi: UsersApi;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    usersApi = TestBed.inject(UsersApi);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify();
    TestBed.resetTestingModule();
  });

  /**
   * CONTRACT: Every URL below carries ONE "/v1", supplied by APP_CONFIG. A path
   * written with the prefix already on it produces "/v1/v1/users/…", which the
   * gateway answers with its own 404 instead of reaching Users — and every
   * assertion here is what catches that.
   */
  it('posts a login to the prefixed path with email and password', () => {
    usersApi.login('jane@example.com', 'hunter2!').subscribe();

    const request = controller.expectOne('/v1/users/login');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ email: 'jane@example.com', password: 'hunter2!' });
    request.flush({ idToken: 'i', accessToken: 'a', refreshToken: 'r' });
  });

  it('posts only the email to otp/start', () => {
    usersApi.startOtp('jane@example.com').subscribe();

    const request = controller.expectOne('/v1/users/otp/start');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ email: 'jane@example.com' });
    request.flush({ session: 'opaque-session' });
  });

  it('posts email, session and code together to otp/verify', () => {
    usersApi
      .verifyOtp({ email: 'jane@example.com', session: 'opaque-session', code: '123456' })
      .subscribe();

    const request = controller.expectOne('/v1/users/otp/verify');
    expect(request.request.body).toEqual({
      email: 'jane@example.com',
      session: 'opaque-session',
      code: '123456',
    });
    request.flush({ idToken: 'i', accessToken: 'a', refreshToken: 'r' });
  });

  it('posts a registration with the optional fields omitted when absent', () => {
    usersApi
      .register({ email: 'jane@example.com', password: 'hunter2!', fullName: 'Jane Doe' })
      .subscribe();

    const request = controller.expectOne('/v1/users/register');
    expect(request.request.body).toEqual({
      email: 'jane@example.com',
      password: 'hunter2!',
      fullName: 'Jane Doe',
    });
    request.flush({});
  });

  it('posts a passwordless registration with no password field', () => {
    usersApi.registerPasswordless({ email: 'jane@example.com', fullName: 'Jane Doe' }).subscribe();

    const request = controller.expectOne('/v1/users/register/passwordless');
    expect(request.request.body).toEqual({ email: 'jane@example.com', fullName: 'Jane Doe' });
    expect(Object.keys(request.request.body as object)).not.toContain('password');
    request.flush({});
  });

  it('posts only the email to password/forgot', () => {
    usersApi.forgotPassword('jane@example.com').subscribe();

    const request = controller.expectOne('/v1/users/password/forgot');
    expect(request.request.body).toEqual({ email: 'jane@example.com' });
    request.flush({ status: 'accepted' }, { status: 202, statusText: 'Accepted' });
  });

  it('posts email, code and newPassword to password/confirm', () => {
    usersApi
      .confirmPasswordReset({
        email: 'jane@example.com',
        code: '123456',
        newPassword: 'NewPassw0rd!',
      })
      .subscribe();

    const request = controller.expectOne('/v1/users/password/confirm');
    expect(request.request.body).toEqual({
      email: 'jane@example.com',
      code: '123456',
      newPassword: 'NewPassw0rd!',
    });
    request.flush({ status: 'password_updated' });
  });

  it('reads the profile from /users/me', () => {
    usersApi.me().subscribe();

    const request = controller.expectOne('/v1/users/me');
    expect(request.request.method).toBe('GET');
    request.flush({});
  });
});
