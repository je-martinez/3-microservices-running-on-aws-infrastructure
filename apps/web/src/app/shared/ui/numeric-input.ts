import { detectCardBrand } from './card-validation';

export function digitsOnly(value: string, maxLength?: number): string {
  const digits = value.replace(/\D/g, '');
  return maxLength === undefined ? digits : digits.slice(0, maxLength);
}

/**
 * CONTRACT: The single definition of the card number's on-screen shape, brand
 * aware — Amex groups 4-6-5, every other brand 4-4-4-4-3. Typing and dev
 * autofill both route through it, so a filled field is indistinguishable from a
 * typed one and the input's maxlength stays sized for one format.
 */
export function groupCardDigits(value: string): string {
  const digits = digitsOnly(value, 19);
  const pattern = detectCardBrand(digits) === 'amex' ? [4, 6, 5] : [4, 4, 4, 4, 3];
  const groups: string[] = [];
  let index = 0;
  for (const size of pattern) {
    if (index >= digits.length) break;
    groups.push(digits.slice(index, index + size));
    index += size;
  }
  return groups.join(' ');
}
