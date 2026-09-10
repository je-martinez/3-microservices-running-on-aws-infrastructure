import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { PasswordResetStore } from './password-reset';
import { SetNewPasswordPage } from './set-new-password';
import {
  AUTH_TEST_PROVIDERS,
  awaitRequest,
  fillField,
  resetStorage,
  settle,
  submitForm,
  textOf,
} from './testing';

function fillValidForm(fixture: ComponentFixture<SetNewPasswordPage>, code: string): void {
  fillField(fixture, 'Reset code', code);
  fillField(fixture, 'New password', 'NewPassw0rd!');
  fillField(fixture, 'Confirm new password', 'NewPassw0rd!');
}

describe('SetNewPasswordPage', () => {
  let fixture: ComponentFixture<SetNewPasswordPage>;
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
    // The reset request screen puts the email here; this screen never asks again.
    TestBed.inject(PasswordResetStore).request('jane@example.com');
    fixture = TestBed.createComponent(SetNewPasswordPage);
    fixture.detectChanges();
  });

  afterEach(() => {
    controller.verify();
    TestBed.resetTestingModule();
  });

  it('posts email, code and newPassword together, then returns to sign-in', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    fillValidForm(fixture, '123456');
    submitForm(fixture);

    const request = await awaitRequest(fixture, controller, '/v1/users/password/confirm');
    expect(request.request.body).toEqual({
      email: 'jane@example.com',
      code: '123456',
      newPassword: 'NewPassw0rd!',
    });
    request.flush({ status: 'password_updated' });
    await settle(fixture);

    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('rejects a code that is not six digits without issuing a request', async () => {
    fillValidForm(fixture, '12345');
    submitForm(fixture);
    await settle(fixture);

    controller.expectNone('/v1/users/password/confirm');
    expect(textOf(fixture, '[role="alert"]')).toContain('6-digit code');
  });

  // WHY: the shared numeric Field strips non-digits before it emits, so this
  // guarantee lives in the template rather than the screen's handler. Assert
  // the rendered input and the request body, not the handler.
  it('strips non-digits from the reset code so a letter can never reach the request', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    fillValidForm(fixture, '12a34b56');

    const codeField = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('app-field'),
    ).find((element) => element.querySelector('span')?.textContent?.trim().startsWith('Reset code'));
    expect(codeField?.querySelector('input')?.value).toBe('123456');

    submitForm(fixture);
    const request = await awaitRequest(fixture, controller, '/v1/users/password/confirm');
    expect(request.request.body).toMatchObject({ code: '123456' });
    request.flush({ status: 'password_updated' });
    await settle(fixture);

    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('rejects a password under eight characters without issuing a request', async () => {
    fillField(fixture, 'Reset code', '123456');
    fillField(fixture, 'New password', 'Short1!');
    fillField(fixture, 'Confirm new password', 'Short1!');
    submitForm(fixture);
    await settle(fixture);

    controller.expectNone('/v1/users/password/confirm');
    expect(textOf(fixture, '[role="alert"]')).toContain('at least 8 characters');
  });

  it('rejects a mismatched confirmation without issuing a request', async () => {
    fillField(fixture, 'Reset code', '123456');
    fillField(fixture, 'New password', 'NewPassw0rd!');
    fillField(fixture, 'Confirm new password', 'NewPassw0rd?');
    submitForm(fixture);
    await settle(fixture);

    controller.expectNone('/v1/users/password/confirm');
    expect(textOf(fixture, '[role="alert"]')).toContain('do not match');
  });

  /**
   * WARNING: The four checklist rules are a guide, not a gate. Cognito's pool
   * policy is applied server-side and this app cannot read it, so a password
   * that ticks every box here can still be refused — and the server's own
   * wording is what tells the user why.
   */
  it('surfaces the server rejection of a password that passed every client rule', async () => {
    fillValidForm(fixture, '123456');
    submitForm(fixture);

    (await awaitRequest(fixture, controller, '/v1/users/password/confirm')).flush(
      {
        statusCode: 400,
        code: 'FST_ERR_VALIDATION',
        error: 'Bad Request',
        message: 'Password does not conform to policy: not long enough',
      },
      { status: 400, statusText: 'Bad Request' },
    );
    await settle(fixture);

    // ApiError.detail prefers `message` over the useless `error: "Bad Request"`.
    expect(textOf(fixture, '[role="alert"]')).toContain('does not conform to policy');
  });

  it('reports a bad or expired code on a 401', async () => {
    fillValidForm(fixture, '000000');
    submitForm(fixture);

    (await awaitRequest(fixture, controller, '/v1/users/password/confirm')).flush(
      { error: 'Invalid or expired code' },
      { status: 401, statusText: 'Unauthorized' },
    );
    await settle(fixture);

    expect(textOf(fixture, '[role="alert"]')).toContain('not right');
  });

  it('makes the password checklist live rather than fixed', async () => {
    fillField(fixture, 'New password', 'alllowercase');
    await settle(fixture);

    const rows = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.rounded-full'),
    );
    const met = rows.filter((row) => row.querySelector('svg')).length;
    // Length only: no uppercase, no digit, no symbol.
    expect(met).toBe(1);
  });
});
