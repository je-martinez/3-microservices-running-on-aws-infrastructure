import { Component, input } from '@angular/core';

/**
 * Design: frame `Logo Lockup` (M8f7U). Mark + wordmark ("3M" navy, "RAI"
 * orange), sharing `img/standalone-logo.png` with the email templates.
 * `onDark` covers the Brand Panel / Mobile Brand Header instances, which paint
 * "3M" with the surface-white token (not `ink-on-dark`) and leave "RAI" orange.
 */
@Component({
  selector: 'app-logo-lockup',
  templateUrl: './logo-lockup.html',
})
export class LogoLockup {
  /** True on the navy Brand Panel / Mobile Brand Header instances. */
  readonly onDark = input(false);

  /**
   * Drops the wordmark below 360px, keeping the mark. Opt-in because only the
   * app header is width-contended there — the auth brand panels own the whole
   * viewport and keep the full lockup.
   */
  readonly hideWordmarkOnTiny = input(false);
}
