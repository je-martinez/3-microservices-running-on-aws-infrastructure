import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowLeft, LucideCheck, LucideInfo } from '@lucide/angular';
import { BrandPanel } from '../../shared/ui/brand-panel';
import { MobileBrandHeader } from '../../shared/ui/mobile-brand-header';
import { Field } from '../../shared/ui/field';
import { ButtonPrimary } from '../../shared/ui/button-primary';
import { ButtonGhost } from '../../shared/ui/button-ghost';

/**
 * Design: `Register — Passwordless` (UK1Bu, 1440) and
 *         `Mobile — Register Passwordless` (t2OrS, 390).
 * One component, two breakpoints (spec D8, DESIGN.md "Responsive rule").
 * Phase 1: layout and navigation only — the form does not submit anywhere.
 */
@Component({
  selector: 'app-register-passwordless',
  imports: [
    RouterLink,
    LucideArrowLeft,
    LucideCheck,
    LucideInfo,
    BrandPanel,
    MobileBrandHeader,
    Field,
    ButtonPrimary,
    ButtonGhost,
  ],
  template: `
    <main class="bg-surface-white flex min-h-screen w-full flex-col lg:flex-row">
      <app-brand-panel class="hidden lg:flex lg:h-screen lg:w-[560px] lg:shrink-0" />
      <app-mobile-brand-header class="lg:hidden" />

      <section class="flex flex-1 flex-col items-center justify-center px-6 py-10 lg:px-10">
        <form
          class="flex w-full max-w-[480px] flex-col gap-6"
          (submit)="$event.preventDefault()"
        >
          <a routerLink="/register" class="text-ink-secondary inline-flex w-fit items-center gap-[7px]">
            <svg lucideArrowLeft class="h-4 w-4"></svg>
            <span class="text-sm font-semibold">Back to sign up</span>
          </a>

          <div class="flex flex-col gap-2.5">
            <h1 class="font-heading text-ink-primary text-[26px] font-bold tracking-tight lg:text-[33px]">
              Sign up with just your email
            </h1>
            <p class="font-body text-ink-secondary text-[14.5px] leading-[1.55] lg:text-base">
              No password to create. We'll send a 6-digit code to confirm it's you.
            </p>
          </div>

          <div class="flex w-full flex-col gap-4">
            <app-field label="Full name" icon="user" placeholder="Jose Martinez" />
            <app-field label="Email" type="email" icon="mail" placeholder="you@example.com" />
          </div>

          <label class="flex w-full items-center gap-[9px]">
            <!-- TODO(phase-2): inert — hardcoded checked, nothing observes it, the
                 checkmark below always renders. Needs wiring to real form state. -->
            <input type="checkbox" checked class="sr-only" />
            <span class="bg-brand-navy flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded">
              <svg lucideCheck class="h-3 w-3 text-white"></svg>
            </span>
            <span class="text-sm">
              <span class="text-ink-secondary">I agree to the</span>
              <span class="text-brand-navy font-semibold"> Terms </span>
              <span class="text-ink-secondary">and</span>
              <span class="text-brand-navy font-semibold"> Privacy Policy</span>
            </span>
          </label>

          <app-button-primary label="Send me a code" icon="arrow-right" />

          <div class="bg-brand-orange-light flex w-full items-center gap-[10px] rounded-md p-3.5">
            <svg lucideInfo class="text-brand-orange h-4 w-4 shrink-0"></svg>
            <p class="text-ink-on-orange-light flex-1 text-[13.5px] leading-[1.5]">
              You can add a password later from your account settings.
            </p>
          </div>

          <div class="flex w-full items-center gap-[14px]">
            <span class="bg-line h-px flex-1"></span>
            <span class="text-ink-muted text-[13px]">or</span>
            <span class="bg-line h-px flex-1"></span>
          </div>

          <a routerLink="/register" class="block w-full">
            <app-button-ghost label="Use email and password" icon="lock" />
          </a>

          <p class="flex w-full justify-center gap-[5px] text-[15px]">
            <span class="text-ink-secondary">Already have an account?</span>
            <a routerLink="/login" class="text-brand-navy font-semibold">Sign in</a>
          </p>
        </form>
      </section>
    </main>
  `,
})
export class RegisterPasswordlessPage {}
