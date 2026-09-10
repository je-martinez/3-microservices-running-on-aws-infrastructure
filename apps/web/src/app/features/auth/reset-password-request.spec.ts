import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { PasswordResetStore } from './password-reset';
import { ResetPasswordRequestPage } from './reset-password-request';
import {
  AUTH_TEST_PROVIDERS,
  awaitRequest,
  fillField,
  resetStorage,
  settle,
  submitForm,
  textOf,
} from './testing';

/** Users answers 202 with this body for every accepted request, known or not. */
const ACCEPTED = { status: 'accepted' };
const ACCEPTED_OPTIONS = { status: 202, statusText: 'Accepted' };

function build(): ComponentFixture<ResetPasswordRequestPage> {
  const fixture = TestBed.createComponent(ResetPasswordRequestPage);
  fixture.detectChanges();
  return fixture;
}

/** Submits the form and renders whatever the endpoint's 202 produced. */
async function requestReset(
  fixture: ComponentFixture<ResetPasswordRequestPage>,
  controller: HttpTestingController,
  email: string,
): Promise<string> {
  fillField(fixture, 'Email', email);
  submitForm(fixture);

  const request = await awaitRequest(fixture, controller, '/v1/users/password/forgot');
  expect(request.request.body).toEqual({ email });
  request.flush(ACCEPTED, ACCEPTED_OPTIONS);
  await settle(fixture);

  return textOf(fixture, '[role="status"]');
}

describe('ResetPasswordRequestPage', () => {
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

  /**
   * CONTRACT: The account-enumeration guard. POST /users/password/forgot
   * answers an identical 202 for a known and an unknown email; a UI branching
   * on which it was hands back the oracle the endpoint denies.
   * See [[2026-09-04-web-gateway-integration-design]]
   */
  it('renders the IDENTICAL confirmation for a known and an unknown email', async () => {
    const known = await requestReset(build(), controller, 'jane@example.com');

    TestBed.inject(PasswordResetStore).clear();
    const unknown = await requestReset(build(), controller, 'nobody@example.com');

    expect(known).not.toBe('');
    expect(unknown).toBe(known);
    expect(known).toContain('If an account exists');
  });

  it('hides the email field once the request is accepted, for either email', async () => {
    const fixture = build();
    await requestReset(fixture, controller, 'nobody@example.com');

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('app-field')).toBeNull();
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('carries the email to the set-new-password screen', async () => {
    await requestReset(build(), controller, 'jane@example.com');

    expect(TestBed.inject(PasswordResetStore).email()).toBe('jane@example.com');
  });

  it('blocks a malformed email client-side, and shows no confirmation', async () => {
    const fixture = build();
    fillField(fixture, 'Email', 'not-an-email');
    submitForm(fixture);
    await settle(fixture);

    controller.expectNone('/v1/users/password/forgot');
    expect(textOf(fixture, '[role="status"]')).toBe('');
    expect(textOf(fixture, '[role="alert"]')).toContain('valid email');
  });

  it('surfaces a transport failure rather than a false confirmation', async () => {
    const fixture = build();
    fillField(fixture, 'Email', 'jane@example.com');
    submitForm(fixture);

    (await awaitRequest(fixture, controller, '/v1/users/password/forgot')).error(
      new ProgressEvent('error'),
      { status: 0, statusText: 'Unknown Error' },
    );
    await settle(fixture);

    expect(textOf(fixture, '[role="status"]')).toBe('');
    expect(textOf(fixture, '[role="alert"]')).toContain('could not reach the server');
  });
});
