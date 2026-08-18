import { Component } from '@angular/core';
import { LucidePackage, LucideShieldCheck, LucideTruck } from '@lucide/angular';
import { LogoLockup } from './logo-lockup';

/**
 * Design: frame `Brand Panel` (WXmng). The navy marketing rail alongside
 * auth screens (login/register/verify/forgot-password), fixed 560x1024 in
 * the desktop frame — the mobile pair instead uses `Mobile Brand Header`.
 *
 * The `Panel Image` node is a remote Unsplash placeholder
 * (images.unsplash.com/photo-1632463593837-...), not a repo asset or final
 * artwork — per DESIGN.md's Assets table this renders as a token-coloured
 * placeholder rather than a hotlinked production image.
 *
 * `Panel Subtitle`/`Feature Label` originally had no matching token
 * (#A9B2C0/#C7CDD8 vs. the closest existing `ink-on-dark` at #E8EAEE) —
 * `ink-muted-on-dark`/`ink-subtle-on-dark` were added to styles.css to
 * close that gap, so both now bind to real tokens, not a substitution.
 */
@Component({
  selector: 'app-brand-panel',
  imports: [LogoLockup, LucidePackage, LucideShieldCheck, LucideTruck],
  template: `
    <div class="bg-brand-navy-deep flex h-full w-full flex-col justify-between gap-14 overflow-hidden p-14">
      <app-logo-lockup [onDark]="true" />

      <div class="flex w-full flex-col gap-[18px]">
        <span class="text-brand-orange text-[11px] font-semibold tracking-[3.5px]">MARKETPLACE</span>
        <h1 class="text-surface-white text-[40px] leading-[1.15] font-bold tracking-[-1px]">
          Fewer clicks between you and what you want.
        </h1>
        <p class="text-ink-muted-on-dark text-[15px] leading-[1.65]">
          One account for your orders, tracking and returns. Sign in with a password — or skip it
          entirely and use a one-time code.
        </p>
      </div>

      <!-- Panel Image: design references a remote Unsplash placeholder here, not
           final artwork — rendered as a token-coloured placeholder (see DESIGN.md
           "Assets") until real imagery is supplied. -->
      <div class="bg-brand-navy h-[280px] w-full shrink-0 rounded-2xl"></div>

      <div class="flex w-full flex-col gap-[14px]">
        <div class="flex w-full items-center gap-[10px]">
          <svg lucidePackage class="text-brand-orange text-[17px]"></svg>
          <span class="text-ink-subtle-on-dark text-sm">Free returns within 30 days</span>
        </div>
        <div class="flex w-full items-center gap-[10px]">
          <svg lucideShieldCheck class="text-brand-orange text-[17px]"></svg>
          <span class="text-ink-subtle-on-dark text-sm">Checkout secured end to end</span>
        </div>
        <div class="flex w-full items-center gap-[10px]">
          <svg lucideTruck class="text-brand-orange text-[17px]"></svg>
          <span class="text-ink-subtle-on-dark text-sm">Same-day dispatch before 4 pm</span>
        </div>
      </div>
    </div>
  `,
})
export class BrandPanel {}
