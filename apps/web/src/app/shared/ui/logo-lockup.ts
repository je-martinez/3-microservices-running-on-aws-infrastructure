import { Component, input } from '@angular/core';

/**
 * Design: frame `Logo Lockup` (M8f7U). Mark + wordmark ("3M" navy, "RAI"
 * orange). The mark image is the same `img/standalone-logo.png` asset used
 * by the email templates (see assets/assets.manifest.json).
 *
 * `onDark` covers the two instances that override the wordmark to white on
 * the navy Brand Panel / Mobile Brand Header (Get('WXmng')/Get('u2nnov')
 * both override Logo 3M's fill to #FFFFFF — the surface-white token, not
 * ink-on-dark — while Logo RAI stays brand-orange).
 */
@Component({
  selector: 'app-logo-lockup',
  templateUrl: './logo-lockup.html',
})
export class LogoLockup {
  /** True on the navy Brand Panel / Mobile Brand Header instances. */
  readonly onDark = input(false);
}
