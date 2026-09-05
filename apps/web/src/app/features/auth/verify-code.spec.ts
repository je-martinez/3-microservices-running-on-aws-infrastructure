import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { SessionStore } from '../../core/auth/session-store';
import { TokenStore } from '../../core/auth/token-store';
import { LoginPasswordlessPage } from './login-passwordless';
import { OtpChallengeStore } from './otp-challenge';
import { VerifyCodePage } from './verify-code';
import {
  AUTH_TEST_PROVIDERS,
  USER,
  awaitRequest,
  fillField,
  fillInput,
  resetStorage,
  settle,
  submitForm,
  textOf,
} from './testing';

const TOKENS = { idToken: 'id', accessToken: 'access', refreshToken: 'refresh' };

function configure(): void {
  resetStorage();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      ...AUTH_TEST_PROVIDERS,
    ],
  });
}

describe('the passwordless OTP flow', () => {
  let controller: HttpTestingController;

  beforeEach(async () => {
    configure();
    await TestBed.compileComponents();
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify();
    TestBed.resetTestingModule();
  });

  it('carries BOTH the email and the session from otp/start to otp/verify', async () => {
    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);

    const start = TestBed.createComponent(LoginPasswordlessPage);
    start.detectChanges();
    fillField(start, 'Email', 'jane@example.com');
    submitForm(start);

    const startRequest = await awaitRequest(start, controller, '/v1/users/otp/start');
    expect(startRequest.request.body).toEqual({ email: 'jane@example.com' });
    startRequest.flush({ session: 'opaque-session' });
    await settle(start);

    // The two screens share only OtpChallengeStore — nothing is passed in the URL.
    expect(TestBed.inject(OtpChallengeStore).current()).toEqual({
      email: 'jane@example.com',
      session: 'opaque-session',
    });

    const verify = TestBed.createComponent(VerifyCodePage);
    verify.detectChanges();
    fillInput(verify, 'Verification code', '123456');
    submitForm(verify);

    const verifyRequest = await awaitRequest(verify, controller, '/v1/users/otp/verify');
    expect(verifyRequest.request.body).toEqual({
      email: 'jane@example.com',
      session: 'opaque-session',
      code: '123456',
    });
    verifyRequest.flush(TOKENS);

    (await awaitRequest(verify, controller, '/v1/users/me')).flush(USER);
    await settle(verify);

    await expect(TestBed.inject(TokenStore).read()).resolves.toEqual(TOKENS);
    expect(TestBed.inject(SessionStore).user()).toEqual(USER);
  });
});

describe('VerifyCodePage', () => {
  let fixture: ComponentFixture<VerifyCodePage>;
  let controller: HttpTestingController;

  beforeEach(async () => {
    configure();
    await TestBed.compileComponents();
    controller = TestBed.inject(HttpTestingController);
    TestBed.inject(OtpChallengeStore).start({
      email: 'jane@example.com',
      session: 'opaque-session',
    });
    fixture = TestBed.createComponent(VerifyCodePage);
    fixture.detectChanges();
  });

  afterEach(() => {
    controller.verify();
    TestBed.resetTestingModule();
  });

  it('rejects a code shorter than six digits without issuing a request', async () => {
    fillInput(fixture, 'Verification code', '1234');
    submitForm(fixture);
    await settle(fixture);

    // controller.verify() in afterEach is the other half of this assertion: an
    // unexpected outgoing request fails the test even if the message rendered.
    controller.expectNone('/v1/users/otp/verify');
    expect(textOf(fixture, '[role="alert"]')).toContain('6-digit code');
  });

  it('strips non-digits so a letter can never reach the request', async () => {
    fillInput(fixture, 'Verification code', '12a34b');
    submitForm(fixture);
    await settle(fixture);

    controller.expectNone('/v1/users/otp/verify');
    expect(textOf(fixture, '[role="alert"]')).toContain('6-digit code');
  });

  it('shows a retry message on a 401 and keeps the user on the screen', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);

    fillInput(fixture, 'Verification code', '000000');
    submitForm(fixture);

    (await awaitRequest(fixture, controller, '/v1/users/otp/verify')).flush(
      { error: 'Invalid code' },
      { status: 401, statusText: 'Unauthorized' },
    );
    await settle(fixture);

    expect(textOf(fixture, '[role="alert"]')).toContain('not right');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('replaces the session on a resend, so the new code is the one verified', async () => {
    const resend = (fixture.nativeElement as HTMLElement).querySelectorAll('button');
    const resendButton = Array.from(resend).find((b) => b.textContent?.includes('Resend'));
    resendButton?.click();
    fixture.detectChanges();

    (await awaitRequest(fixture, controller, '/v1/users/otp/start')).flush({
      session: 'second-session',
    });
    await settle(fixture);

    expect(TestBed.inject(OtpChallengeStore).current()).toEqual({
      email: 'jane@example.com',
      session: 'second-session',
    });
  });
});
