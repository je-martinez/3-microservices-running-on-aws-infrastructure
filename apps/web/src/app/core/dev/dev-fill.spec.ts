import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { DevFillButton } from './dev-fill-button';
import { DEV_MODE, devData, resetDevData, sessionDevData } from './dev-fill';

describe('devData', () => {
  beforeEach(() => {
    resetDevData();
  });

  /**
   * CONTRACT: This is the guarantee the whole design rests on. Chance is a
   * 472 kB non-ESM monolith; if it were reachable outside dev mode it would sit
   * in a production bundle against a 1 MB budget.
   */
  it('generates nothing outside dev mode', async () => {
    await expect(devData(false)).resolves.toBeNull();
  });

  it('generates a full set in dev mode', async () => {
    const data = await devData(true);

    expect(data).not.toBeNull();
    for (const [key, value] of Object.entries(data ?? {})) {
      expect(value, `${key} should be a non-empty string`).toBeTypeOf('string');
      expect(value, `${key} should be a non-empty string`).not.toBe('');
    }
  });

  /**
   * WHY: Cognito's pool policy rejects a password this app's own client-side
   * length check accepts, so a generated one that trips it would look like a
   * backend failure rather than bad test data.
   */
  /**
   * CONTRACT: A REAL Stripe test number. `chance.cc()` yields a Luhn-valid Visa
   * that Stripe REJECTS. See [[2026-09-07-dev-form-autofill]]
   */
  it('generates a card number Stripe actually accepts in test mode', async () => {
    const data = await devData(true);

    expect(data!.cardNumber).toBe('4242424242424242');
  });

  /** Any FUTURE date is accepted; a hardcoded year stops being one. */
  it('generates an expiry that is still in the future', async () => {
    const data = await devData(true);

    const [month, year] = data!.cardExpiry.split('/').map((part) => Number(part.trim()));
    expect(month).toBeGreaterThanOrEqual(1);
    expect(month).toBeLessThanOrEqual(12);
    // Two digits, as the form renders them, and beyond the current year.
    expect(year).toBeGreaterThan(new Date().getUTCFullYear() % 100);
  });

  it('generates a three-digit CVC', async () => {
    const data = await devData(true);

    expect(data!.cardCvc).toMatch(/^\d{3}$/);
  });

  it('generates a password Cognito accepts', async () => {
    const password = (await devData(true))?.password ?? '';

    expect(password.length).toBeGreaterThanOrEqual(8);
    expect(password, 'needs an uppercase letter').toMatch(/[A-Z]/);
    expect(password, 'needs a lowercase letter').toMatch(/[a-z]/);
    expect(password, 'needs a digit').toMatch(/\d/);
    expect(password, 'needs a symbol').toMatch(/[^A-Za-z0-9]/);
  });

  /** The phone field parses the number to pick a flag; +1 809 must read as DO. */
  it('generates a Dominican phone number in E.164', async () => {
    expect((await devData(true))?.phoneNumber).toMatch(/^\+1809\d{7}$/);
  });

  /**
   * The checkout form splits this string on commas and treats a trailing
   * 3-10 character token as the postal code — see `parseAddress()`.
   */
  it('generates a city and postal code the checkout parser can split', async () => {
    const parts = ((await devData(true))?.cityAndPostalCode ?? '')
      .split(',')
      .map((part) => part.trim());

    expect(parts.length).toBe(2);
    expect(parts[1]).toMatch(/^\d{5}$/);
  });

  it('caches one identity per session and replaces it on reset', async () => {
    const first = await sessionDevData(true);
    expect(await sessionDevData(true)).toBe(first);

    resetDevData();
    expect(await sessionDevData(true)).not.toBe(first);
  });

  it('caches nothing outside dev mode', async () => {
    await expect(sessionDevData(false)).resolves.toBeNull();
  });
});

describe('DevFillButton', () => {
  /** Builds the component with DEV_MODE forced, the way a build would set it. */
  function createButton(devMode: boolean) {
    TestBed.configureTestingModule({
      providers: [{ provide: DEV_MODE, useValue: devMode }],
    });
    const fixture = TestBed.createComponent(DevFillButton);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    resetDevData();
    TestBed.resetTestingModule();
  });

  it('renders nothing outside dev mode', () => {
    const fixture = createButton(false);

    expect(
      fixture.nativeElement.querySelector('[data-testid="dev-fill"]'),
      'the control must not exist in a production build',
    ).toBeNull();
  });

  it('renders a button in dev mode and emits a generated set when clicked', async () => {
    const fixture = createButton(true);

    const button: HTMLButtonElement | null = fixture.nativeElement.querySelector(
      '[data-testid="dev-fill"]',
    );
    expect(button).not.toBeNull();

    const emitted = new Promise((resolve) => {
      fixture.componentInstance.filled.subscribe(resolve);
    });
    button?.click();

    await expect(emitted).resolves.toHaveProperty('email');
  });
});
