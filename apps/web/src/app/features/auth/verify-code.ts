import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowLeft, LucideShieldCheck, LucideTimer } from '@lucide/angular';
import { BrandPanel } from '../../shared/ui/brand-panel';
import { MobileBrandHeader } from '../../shared/ui/mobile-brand-header';
import { OtpDigit } from '../../shared/ui/otp-digit';
import { ButtonPrimary } from '../../shared/ui/button-primary';

/**
 * Design: `Verify Code — OTP` (V16TI, 1440) and
 *         `Mobile — Verify Code` (zouHC, 390).
 * One component, two breakpoints (spec D8, DESIGN.md "Responsive rule").
 * The code is 6 digits (`^\d{6}$` in `OtpVerifyInput`) — composed from six
 * `OtpDigit`s. Phase 1: layout and navigation only, no submission.
 */
@Component({
  selector: 'app-verify-code',
  imports: [
    RouterLink,
    LucideArrowLeft,
    LucideTimer,
    LucideShieldCheck,
    BrandPanel,
    MobileBrandHeader,
    OtpDigit,
    ButtonPrimary,
  ],
  template: `
    <main class="bg-surface-white flex min-h-screen w-full flex-col lg:flex-row">
      <app-brand-panel class="hidden lg:flex lg:h-screen lg:w-[560px] lg:shrink-0" />
      <app-mobile-brand-header class="lg:hidden" />

      <section class="flex flex-1 flex-col items-center justify-center px-6 py-10 lg:px-10">
        <form
          class="flex w-full max-w-[480px] flex-col gap-6 lg:gap-7"
          (submit)="$event.preventDefault()"
        >
          <a routerLink="/login/passwordless" class="text-ink-secondary inline-flex w-fit items-center gap-[7px]">
            <svg lucideArrowLeft class="h-4 w-4"></svg>
            <span class="text-sm font-semibold">Use a different email</span>
          </a>

          <div class="flex flex-col gap-2.5">
            <h1 class="font-heading text-ink-primary text-[26px] font-bold tracking-tight lg:text-[33px]">
              Check your inbox
            </h1>
            <p class="font-body text-ink-secondary text-[14.5px] leading-[1.55] lg:text-base">
              We sent a 6-digit code to your email. Enter it below to finish signing in.
            </p>
          </div>

          <div class="flex w-full flex-col gap-3">
            <div class="flex w-full gap-3">
              <app-otp-digit class="flex-1" value="4" />
              <app-otp-digit class="flex-1" value="8" />
              <app-otp-digit class="flex-1" value="3" />
              <app-otp-digit class="flex-1" />
              <app-otp-digit class="flex-1" />
              <app-otp-digit class="flex-1" />
            </div>
            <div class="flex items-center gap-[6px]">
              <svg lucideTimer class="text-ink-muted h-[14px] w-[14px]"></svg>
              <span class="text-ink-muted text-sm">Code expires in 09:42</span>
            </div>
          </div>

          <app-button-primary label="Verify and continue" icon="arrow-right" />

          <p class="flex w-full justify-center gap-[5px] text-[15px]">
            <span class="text-ink-secondary">Didn't receive it?</span>
            <button type="button" class="text-brand-navy font-semibold">Resend code</button>
          </p>

          <div class="bg-surface-subtle flex w-full items-center gap-[10px] rounded-md p-3.5">
            <svg lucideShieldCheck class="text-ink-secondary h-4 w-4 shrink-0"></svg>
            <p class="text-ink-secondary flex-1 text-[13.5px] leading-[1.5]">
              Didn't ask for this code? You can safely ignore the email.
            </p>
          </div>
        </form>
      </section>
    </main>
  `,
})
export class VerifyCodePage {}
