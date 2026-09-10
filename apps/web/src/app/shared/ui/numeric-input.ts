export function digitsOnly(value: string, maxLength?: number): string {
  const digits = value.replace(/\D/g, '');
  return maxLength === undefined ? digits : digits.slice(0, maxLength);
}

/**
 * CONTRACT: The single definition of the card number's on-screen shape. Typing
 * and dev autofill both route through it, so a filled field is indistinguishable
 * from a typed one and the input's maxlength stays sized for one format.
 */
export function groupCardDigits(value: string): string {
  return digitsOnly(value, 19)
    .replace(/(.{4})/g, '$1 ')
    .trimEnd();
}
