import { InjectionToken, isDevMode } from '@angular/core';

/**
 * Development-only form filling, backed by Chance.js.
 *
 * CONTRACT: Chance is loaded through a DYNAMIC import, never a static one. The
 * package is a 472 kB UMD monolith with no ESM entry point, so a static import
 * pulls every generator into the initial bundle — against a 1 MB budget that
 * fails the build. The dynamic import keeps it in a separate chunk that a
 * production build never requests, because `isDevMode()` gates the only call.
 * See [[2026-09-07-dev-form-autofill]]
 */

/**
 * CONTRACT: Dev-only affordances read this token, never a bare `isDevMode()` —
 * an ESM namespace export cannot be spied on, so a test asserting the
 * production behaviour has no other way to flip it.
 */
export const DEV_MODE = new InjectionToken<boolean>('DEV_MODE', {
  providedIn: 'root',
  factory: () => isDevMode(),
});

/** The generators a form recipe may ask for, named after what they produce. */
export interface DevData {
  readonly fullName: string;
  readonly email: string;
  readonly password: string;
  readonly phoneNumber: string;
  readonly street: string;
  readonly apartment: string;
  readonly state: string;
  readonly cityAndPostalCode: string;
  readonly cardNumber: string;
  readonly cardExpiry: string;
  readonly cardCvc: string;
  readonly otpCode: string;
}

/**
 * WHY: Typed against the handful of Chance methods used below rather than
 * pulling in `@types/chance`, which would be a dependency of the app for a
 * dev-only path. The shape is verified by the dynamic import at runtime.
 */
interface ChanceLike {
  name(options?: { nationality?: string }): string;
  email(options?: { domain?: string }): string;
  string(options?: { length?: number; pool?: string }): string;
  phone(options?: { country?: string; formatted?: boolean }): string;
  street(): string;
  city(): string;
  integer(options: { min: number; max: number }): number;
  cc(options?: { type?: string }): string;
  exp(): string;
}

type ChanceConstructor = new () => ChanceLike;

/**
 * CONTRACT: A password Cognito accepts, not a random string. The pool below
 * carries an upper, a lower, a digit and a symbol because the pool alone does
 * not guarantee one of each — the four appended characters do.
 */
function password(chance: ChanceLike): string {
  const body = chance.string({ length: 12, pool: 'abcdefghijkmnpqrstuvwxyz23456789' });
  return `Aa1!${body}`;
}

/**
 * WHY: Dominican addresses, because that is what this app's checkout and its
 * `+1 809` placeholder assume. A postal code is emitted in the 5-digit form
 * Santo Domingo uses, matching what `parseAddress()` expects to find last.
 */
function cityAndPostalCode(chance: ChanceLike): string {
  return `${chance.city()}, ${String(chance.integer({ min: 10100, max: 11999 }))}`;
}

let cached: Promise<DevData> | null = null;

/**
 * Generates one set of plausible values, or null outside dev mode.
 *
 * CONTRACT: Returns null rather than throwing — the caller is a template
 * binding, where a throw breaks the page.
 */
export async function devData(enabled: boolean): Promise<DevData | null> {
  if (!enabled) return null;

  const { default: Chance } = (await import('chance')) as unknown as {
    default: ChanceConstructor;
  };
  const chance = new Chance();

  return {
    fullName: chance.name(),
    email: chance.email({ domain: 'example.com' }),
    password: password(chance),
    phoneNumber: `+1809${String(chance.integer({ min: 2000000, max: 9999999 }))}`,
    street: chance.street(),
    apartment: `Apto ${chance.integer({ min: 1, max: 40 })}${'ABCD'[chance.integer({ min: 0, max: 3 })]}`,
    // The province Santo Domingo sits in, matching the city the generator picks.
    state: 'Distrito Nacional',
    cityAndPostalCode: cityAndPostalCode(chance),
    cardNumber: STRIPE_TEST_CARD,
    // Derived, never fixed: any FUTURE date is accepted, and a hardcoded year
    // stops being one.
    cardExpiry: futureExpiry(),
    cardCvc: String(chance.integer({ min: 100, max: 999 })),
    otpCode: String(chance.integer({ min: 100000, max: 999999 })),
  };
}

/**
 * Stripe's canonical success card — see https://docs.stripe.com/testing
 *
 * CONTRACT: A REAL Stripe test number, never a generated one. `chance.cc()`
 * yields a Luhn-valid Visa that Stripe REJECTS, failing at the one step this
 * button exists to skip. See [[2026-09-07-dev-form-autofill]]
 */
const STRIPE_TEST_CARD = '4242424242424242';

/** `MM / YY` two years out — Stripe accepts any future date. */
function futureExpiry(): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${month} / ${String((now.getUTCFullYear() + 2) % 100).padStart(2, '0')}`;
}

/**
 * WHY: The same generated set for a whole session, so an email typed into
 * register is the one that signs in afterwards. Call `resetDevData()` for a
 * fresh identity.
 */
export function sessionDevData(enabled: boolean): Promise<DevData | null> {
  if (!enabled) return Promise.resolve(null);
  cached ??= devData(enabled).then((data) => data as DevData);
  return cached;
}

export function resetDevData(): void {
  cached = null;
}
