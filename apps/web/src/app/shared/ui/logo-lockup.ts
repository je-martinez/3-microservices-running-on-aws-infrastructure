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
  template: `
    <span class="inline-flex w-fit items-center gap-[10px]">
      <span
        class="h-[36px] w-[36px] shrink-0 rounded-lg bg-surface-white bg-contain bg-center bg-no-repeat"
        style="background-image: url('/img/standalone-logo.png')"
      ></span>
      <span class="inline-flex w-fit items-center gap-px">
        <span
          class="text-[19px] font-extrabold tracking-[-0.3px] whitespace-nowrap"
          [class]="onDark() ? 'text-surface-white' : 'text-brand-navy'"
          >3M</span
        >
        <span class="text-brand-orange text-[19px] font-extrabold tracking-[-0.3px] whitespace-nowrap"
          >RAI</span
        >
      </span>
    </span>
  `,
})
export class LogoLockup {
  /** True on the navy Brand Panel / Mobile Brand Header instances. */
  readonly onDark = input(false);
}
