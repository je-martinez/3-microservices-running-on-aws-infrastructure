import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { SessionStore } from '../../core/auth/session-store';
import { OtpChallengeStore } from './otp-challenge';
import { RegisterPasswordPage } from './register-password';
import { RegisterPasswordlessPage } from './register-passwordless';
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

/** Ticks the Terms checkbox the way a user does — it gates submission. */
function acceptTerms(fixture: { nativeElement: unknown; detectChanges: () => void }): void {
  const root = fixture.nativeElement as HTMLElement;
  const checkbox = root.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!checkbox) throw new Error('No Terms checkbox');
  checkbox.dispatchEvent(new Event('change'));
  fixture.detectChanges();
}

describe('RegisterPasswordPage', () => {
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
  });

  afterEach(() => {
    controller.verify();
    TestBed.resetTestingModule();
  });

  it('registers and then signs in, since register returns a User and not tokens', async () => {
    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(RegisterPasswordPage);
    fixture.detectChanges();

    fillField(fixture, 'Full name', 'Jane Doe');
    fillField(fixture, 'Email', 'jane@example.com');
    fillField(fixture, 'Password', 'hunter2!X');
    acceptTerms(fixture);
    submitForm(fixture);

    const register = await awaitRequest(fixture, controller, '/v1/users/register');
    expect(register.request.body).toEqual({
      email: 'jane@example.com',
      password: 'hunter2!X',
      fullName: 'Jane Doe',
    });
    register.flush(USER);

    (await awaitRequest(fixture, controller, '/v1/users/login')).flush(TOKENS);
    (await awaitRequest(fixture, controller, '/v1/users/me')).flush(USER);
    await settle(fixture);

    expect(TestBed.inject(SessionStore).user()).toEqual(USER);
  });

  it('does not submit a password shorter than eight characters', async () => {
    const fixture = TestBed.createComponent(RegisterPasswordPage);
    fixture.detectChanges();

    fillField(fixture, 'Full name', 'Jane Doe');
    fillField(fixture, 'Email', 'jane@example.com');
    fillField(fixture, 'Password', 'short');
    acceptTerms(fixture);
    submitForm(fixture);
    await settle(fixture);

    controller.expectNone('/v1/users/register');
    expect(textOf(fixture, '[role="alert"]')).toContain('at least 8 characters');
  });

  it('surfaces the SERVER message when the pool policy rejects a locally valid password', async () => {
    const fixture = TestBed.createComponent(RegisterPasswordPage);
    fixture.detectChanges();

    fillField(fixture, 'Full name', 'Jane Doe');
    fillField(fixture, 'Email', 'jane@example.com');
    fillField(fixture, 'Password', 'alllowercase');
    acceptTerms(fixture);
    submitForm(fixture);

    // WARNING: The client length check passes here and the server still says
    // no — Cognito's pool policy is applied on top and is invisible to this
    // app, so its wording has to reach the user unchanged.
    (await awaitRequest(fixture, controller, '/v1/users/register')).flush(
      { error: 'Password did not conform with policy: Password must have uppercase characters' },
      { status: 400, statusText: 'Bad Request' },
    );
    await settle(fixture);

    expect(textOf(fixture, '[role="alert"]')).toContain('uppercase characters');
  });

  it('reports a taken email on a 409', async () => {
    const fixture = TestBed.createComponent(RegisterPasswordPage);
    fixture.detectChanges();

    fillField(fixture, 'Full name', 'Jane Doe');
    fillField(fixture, 'Email', 'jane@example.com');
    fillField(fixture, 'Password', 'hunter2!X');
    acceptTerms(fixture);
    submitForm(fixture);

    (await awaitRequest(fixture, controller, '/v1/users/register')).flush(
      { error: 'Email already registered' },
      { status: 409, statusText: 'Conflict' },
    );
    await settle(fixture);

    expect(textOf(fixture, '[role="alert"]')).toContain('already exists');
  });
});

describe('RegisterPasswordlessPage', () => {
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
  });

  afterEach(() => {
    controller.verify();
    TestBed.resetTestingModule();
  });

  it('registers without a password and starts the OTP challenge', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(RegisterPasswordlessPage);
    fixture.detectChanges();

    fillField(fixture, 'Full name', 'Jane Doe');
    fillField(fixture, 'Email', 'jane@example.com');
    acceptTerms(fixture);
    submitForm(fixture);

    const register = await awaitRequest(fixture, controller, '/v1/users/register/passwordless');
    expect(register.request.body).toEqual({ email: 'jane@example.com', fullName: 'Jane Doe' });
    register.flush(USER);

    (await awaitRequest(fixture, controller, '/v1/users/otp/start')).flush({ session: 'sess' });
    await settle(fixture);

    expect(TestBed.inject(OtpChallengeStore).current()).toEqual({
      email: 'jane@example.com',
      session: 'sess',
    });
    expect(navigate).toHaveBeenCalledWith('/verify');
  });

  it('does not submit until the Terms are accepted', async () => {
    const fixture = TestBed.createComponent(RegisterPasswordlessPage);
    fixture.detectChanges();

    fillField(fixture, 'Full name', 'Jane Doe');
    fillField(fixture, 'Email', 'jane@example.com');
    submitForm(fixture);
    await settle(fixture);

    controller.expectNone('/v1/users/register/passwordless');
    expect(textOf(fixture, '[role="alert"]')).toContain('Terms');
  });
});
