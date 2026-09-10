export function digitsOnly(value: string, maxLength?: number): string {
  const digits = value.replace(/\D/g, '');
  return maxLength === undefined ? digits : digits.slice(0, maxLength);
}
