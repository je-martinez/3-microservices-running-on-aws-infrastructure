import { Component, input, ChangeDetectionStrategy } from '@angular/core';

/**
 * Design: frame `OTP Digit` (NZ7jF). A single 60x68 box holding one
 * character of a one-time code. Screens (Verify Code, Set New Password's
 * forced-reset flow) compose six of these into a code entry row.
 */
@Component({
  selector: 'app-otp-digit',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './otp-digit.html',
})
export class OtpDigit {
  readonly value = input('');
}
