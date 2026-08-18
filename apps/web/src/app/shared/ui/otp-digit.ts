import { Component, input } from '@angular/core';

/**
 * Design: frame `OTP Digit` (NZ7jF). A single 60x68 box holding one
 * character of a one-time code. Screens (Verify Code, Set New Password's
 * forced-reset flow) compose six of these into a code entry row.
 */
@Component({
  selector: 'app-otp-digit',
  template: `
    <span
      class="border-line-strong bg-surface-white text-ink-primary inline-flex h-[68px] w-[60px] items-center justify-center rounded-md border text-[26px] font-semibold"
    >
      {{ value() }}
    </span>
  `,
})
export class OtpDigit {
  readonly value = input('');
}
