import { describe, expect, it } from 'vitest';

import {
  detectCardBrand,
  isValidCardNumber,
  isValidCvc,
  isValidExpiry,
  requiredCvcLength,
} from './card-validation';

describe('isValidCardNumber (Luhn + length)', () => {
  it('accepts a valid Visa number', () => {
    expect(isValidCardNumber('4242424242424242')).toBe(true);
  });

  it('rejects a transposed-digit number of the correct length', () => {
    expect(isValidCardNumber('4242424242424241')).toBe(false);
  });
});

describe('detectCardBrand', () => {
  it.each([
    ['4242424242424242', 'visa'],
    ['5454545454545454', 'mastercard'],
    ['2221000000000009', 'mastercard'],
    ['378282246310005', 'amex'],
    ['6011111111111117', 'discover'],
    ['9999999999999999', 'unknown'],
  ] as const)('detects %s as %s', (number, brand) => {
    expect(detectCardBrand(number)).toBe(brand);
  });
});

describe('isValidCardNumber (length per brand)', () => {
  // WHY: Both rejected numbers PASS Luhn, so length is the only rule left to
  // reject them — a Luhn-invalid literal would pass this suite while
  // `LENGTHS_BY_BRAND` said nothing at all.
  it('rejects a 15-digit Visa', () => {
    expect(isValidCardNumber('424242424242424')).toBe(false);
  });

  it('accepts a 15-digit Amex', () => {
    expect(isValidCardNumber('378282246310005')).toBe(true);
  });

  it('rejects a 16-digit Amex', () => {
    expect(isValidCardNumber('3782822463100052')).toBe(false);
  });

  // CONTRACT: An unlisted issuer is payable. Rejecting the 'unknown' brand
  // outright turns a working card into a form error the buyer cannot clear.
  it('accepts a 12-digit number from an unlisted issuer', () => {
    expect(isValidCardNumber('999999999991')).toBe(true);
  });

  it('rejects an 11-digit number, short for every brand', () => {
    expect(isValidCardNumber('99999999990')).toBe(false);
  });

  it('rejects a number carrying a non-digit', () => {
    expect(isValidCardNumber('4242 4242 4242 4242')).toBe(false);
  });
});

describe('CVC length per brand', () => {
  it('requires 3 digits for Visa', () => {
    expect(requiredCvcLength('visa')).toBe(3);
    expect(isValidCvc('123', 'visa')).toBe(true);
    expect(isValidCvc('1234', 'visa')).toBe(false);
  });

  it('requires 4 digits for Amex', () => {
    expect(requiredCvcLength('amex')).toBe(4);
    expect(isValidCvc('1234', 'amex')).toBe(true);
    expect(isValidCvc('123', 'amex')).toBe(false);
  });

  it('rejects a CVC carrying a non-digit', () => {
    expect(isValidCvc('12a', 'visa')).toBe(false);
  });
});

describe('isValidExpiry', () => {
  // WHY: The clock is injected, never `new Date()` — a spec pinned to a real
  // year starts failing on its own on some future January.
  const today = new Date(2026, 8, 15);

  it('rejects an invalid month', () => {
    expect(isValidExpiry(13, 2030, today)).toBe(false);
  });

  it('rejects month zero', () => {
    expect(isValidExpiry(0, 2030, today)).toBe(false);
  });

  it('rejects a month one month in the past', () => {
    expect(isValidExpiry(8, 2026, today)).toBe(false);
  });

  // CONTRACT: A card expires at the END of its printed month, so the current
  // month is still valid — comparing against the 1st retires every card early.
  it('accepts the current month', () => {
    expect(isValidExpiry(9, 2026, today)).toBe(true);
  });

  it('accepts a future date', () => {
    expect(isValidExpiry(1, 2030, today)).toBe(true);
  });

  it('expands a two-digit year rather than reading it as year 30 AD', () => {
    expect(isValidExpiry(1, 30, today)).toBe(true);
  });

  it('rejects a NaN month or year from a partly typed field', () => {
    expect(isValidExpiry(Number.NaN, 2030, today)).toBe(false);
    expect(isValidExpiry(12, Number.NaN, today)).toBe(false);
  });
});
