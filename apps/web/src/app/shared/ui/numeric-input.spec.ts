import { describe, expect, it } from 'vitest';

import { digitsOnly, groupCardDigits } from './numeric-input';

describe('digitsOnly', () => {
  it('drops every non-digit and caps at the given length', () => {
    expect(digitsOnly('4242-4242a4242 4242', 16)).toBe('4242424242424242');
  });

  it('keeps every digit when no cap is given', () => {
    expect(digitsOnly('1a2b3c')).toBe('123');
  });
});

describe('groupCardDigits', () => {
  it('groups a Visa number in 4s', () => {
    expect(groupCardDigits('4242424242424242')).toBe('4242 4242 4242 4242');
  });

  it('groups an Amex number 4-6-5', () => {
    expect(groupCardDigits('378282246310005')).toBe('3782 822463 10005');
  });

  it('groups a partly typed Amex as far as it goes', () => {
    expect(groupCardDigits('378282')).toBe('3782 82');
  });

  // CONTRACT: 19 digits is the longest card any listed brand issues, and the
  // input's maxlength is sized for the grouped form of exactly that.
  it('caps at 19 digits', () => {
    expect(groupCardDigits('4242424242424242123456')).toBe('4242 4242 4242 4242 123');
  });

  it('leaves no trailing space on a group boundary', () => {
    expect(groupCardDigits('42424242')).toBe('4242 4242');
  });
});
