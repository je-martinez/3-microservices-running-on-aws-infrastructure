/**
 * Pure card helpers, shared by the plain-branch form and the saved-card list.
 * No Angular and no HTTP: every export is a function of its arguments.
 */

export type CardBrand =
  | 'visa'
  | 'mastercard'
  | 'amex'
  | 'discover'
  | 'diners'
  | 'jcb'
  | 'unknown';

/**
 * CONTRACT: An unrecognised prefix yields 'unknown', never a rejection — a
 * valid card from an unlisted issuer must still be payable. Returning null or
 * throwing here turns a working card into an unfixable form error.
 * See [[2026-09-19-stripe-payments-design]]
 */
export function detectCardBrand(digits: string): CardBrand {
  if (/^4/.test(digits)) return 'visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return 'mastercard';
  if (/^3[47]/.test(digits)) return 'amex';
  if (/^(6011|65|64[4-9])/.test(digits)) return 'discover';
  if (/^(30[0-5]|3095|36|38|39)/.test(digits)) return 'diners';
  if (/^35(2[89]|[3-8]\d)/.test(digits)) return 'jcb';
  return 'unknown';
}

/**
 * CONTRACT: An unlisted issuer falls under 'unknown' with the PERMISSIVE 12-19
 * range, never an empty list — narrowing it to the six known brands rejects a
 * working card in a form that charges nothing.
 * See [[2026-09-19-stripe-payments-design]]
 */
const LENGTHS_BY_BRAND: Record<CardBrand, readonly number[]> = {
  visa: [13, 16, 19],
  mastercard: [16],
  amex: [15],
  discover: [16, 19],
  diners: [14, 16, 19],
  jcb: [16, 17, 18, 19],
  unknown: [12, 13, 14, 15, 16, 17, 18, 19],
};

/**
 * CONTRACT: Length alone passes a transposed digit — `4242 4242 4242 4241`
 * carries Visa's 16 digits and is not a card. The checksum is what catches it,
 * so both gates run in `isValidCardNumber`.
 */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = Number(digits[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/** Takes bare digits: strip the grouping with `digitsOnly` before calling. */
export function isValidCardNumber(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  const brand = detectCardBrand(digits);
  return LENGTHS_BY_BRAND[brand].includes(digits.length) && passesLuhn(digits);
}

/** Amex prints a 4-digit code; every other brand, including 'unknown', 3. */
export function requiredCvcLength(brand: CardBrand): 3 | 4 {
  return brand === 'amex' ? 4 : 3;
}

/**
 * CONTRACT: Re-check this whenever the NUMBER changes, not only the code — the
 * required length follows the detected brand, so a 3-digit code already typed
 * turns invalid the moment the number becomes an Amex.
 */
export function isValidCvc(digits: string, brand: CardBrand): boolean {
  return digits.length === requiredCvcLength(brand) && /^\d+$/.test(digits);
}

/**
 * Display labels for the brand slug Stripe sends on the wire, which is
 * lowercase ('amex') where the design shows a name ('American Express').
 */
const BRAND_LABELS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
};

/** Falls back to "Card" for a slug not in the table, and for null. */
export function cardBrandLabel(brand: string | null | undefined): string {
  return (brand && BRAND_LABELS[brand]) || 'Card';
}

/**
 * CONTRACT: A card expires at the END of its printed month, so a card whose
 * `expMonth`/`expYear` match `today` is still VALID. Comparing against the
 * first of the month instead retires every card a month early — on the 1st of
 * April a card printed 04/2028 would read "Expired".
 * See [[2026-09-19-stripe-payments-design]]
 */
export function isCardExpired(
  expMonth: number | null,
  expYear: number | null,
  today: Date = new Date(),
): boolean {
  if (expMonth === null || expYear === null) return false;
  const lastDayOfExpiryMonth = new Date(expYear, expMonth, 0, 23, 59, 59, 999);
  return today.getTime() > lastDayOfExpiryMonth.getTime();
}

/**
 * The typed expiry's own rule: month 01-12, a two-digit year read as 20YY, and
 * not already past.
 *
 * CONTRACT: Defers the date comparison to `isCardExpired` — ONE end-of-month
 * rule serves both the typed form and the saved-card list. A second comparison
 * here drifts from it and the two surfaces then disagree about the same card.
 * See [[2026-09-19-stripe-payments-design]]
 */
export function isValidExpiry(month: number, year: number, today: Date): boolean {
  if (!Number.isInteger(month) || !Number.isInteger(year)) return false;
  if (month < 1 || month > 12) return false;
  const fullYear = year < 100 ? 2000 + year : year;
  return !isCardExpired(month, fullYear, today);
}
