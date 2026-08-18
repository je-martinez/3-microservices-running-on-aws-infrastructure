import { Component } from '@angular/core';
import { LucideCheck, LucideShieldAlert } from '@lucide/angular';
import { BrandPanel } from '../../shared/ui/brand-panel';
import { MobileBrandHeader } from '../../shared/ui/mobile-brand-header';
import { Field } from '../../shared/ui/field';
import { ButtonPrimary } from '../../shared/ui/button-primary';

/**
 * Design: `Set New Password — Forced` (atwtV, 1440) and
 *         `Mobile — Set New Password` (G6lEnQ, 390).
 * One component, two breakpoints (spec D8, DESIGN.md "Responsive rule").
 * Renders the password checklist the frame shows (3 rules met, 1 not) —
 * phase 1 has no live validation wiring that state up yet. Phase 1: layout
 * and navigation only, no submission.
 */
@Component({
  selector: 'app-set-new-password',
  imports: [LucideCheck, LucideShieldAlert, BrandPanel, MobileBrandHeader, Field, ButtonPrimary],
  template: `
    <main class="bg-surface-white flex min-h-screen w-full flex-col lg:flex-row">
      <app-brand-panel class="hidden lg:flex lg:h-screen lg:w-[560px] lg:shrink-0" />
      <app-mobile-brand-header class="lg:hidden" />

      <section class="flex flex-1 flex-col items-center justify-center px-6 py-10 lg:px-10">
        <form
          class="flex w-full max-w-[480px] flex-col gap-6"
          (submit)="$event.preventDefault()"
        >
          <div class="bg-warn-bg flex w-full items-start gap-[11px] rounded-md p-3.5">
            <svg lucideShieldAlert class="text-warn-ink mt-0.5 h-[17px] w-[17px] shrink-0"></svg>
            <div class="flex flex-col gap-[3px]">
              <span class="text-warn-ink text-[13.5px] font-semibold">Password update required</span>
              <p class="text-warn-ink text-[13.5px] leading-[1.45]">
                You signed in with a temporary code. Choose a new password to finish setting up your
                account.
              </p>
            </div>
          </div>

          <div class="flex flex-col gap-2.5">
            <h1 class="font-heading text-ink-primary text-[26px] font-bold tracking-tight lg:text-[33px]">
              Set a new password
            </h1>
            <p class="font-body text-ink-secondary text-[14.5px] leading-[1.55] lg:text-base">
              For your security, this step can't be skipped. You'll use this password the next time
              you sign in.
            </p>
          </div>

          <div class="flex w-full flex-col gap-[18px]">
            <app-field
              label="New password"
              type="password"
              icon="lock"
              trailingIcon="eye-off"
              placeholder="Create a password"
            />
            <app-field
              label="Confirm new password"
              type="password"
              icon="lock-keyhole"
              trailingIcon="eye-off"
              placeholder="Repeat your password"
            />
          </div>

          <div class="border-line bg-surface-subtle flex w-full flex-col gap-[11px] rounded-md border p-4">
            <span class="text-ink-muted text-[11.5px] font-semibold tracking-[1.4px]">
              PASSWORD MUST HAVE
            </span>
            @for (rule of rules; track rule.label) {
              <div class="flex w-full items-center gap-[10px]">
                <span
                  class="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full"
                  [class]="rule.met ? 'bg-success-green' : 'border border-line-strong'"
                >
                  @if (rule.met) {
                    <svg lucideCheck class="h-[11px] w-[11px] text-white"></svg>
                  }
                </span>
                <span class="flex-1 text-[13.5px]" [class]="rule.met ? 'text-ink-primary' : 'text-ink-secondary'">
                  {{ rule.label }}
                </span>
              </div>
            }
          </div>

          <app-button-primary label="Update password & continue" icon="arrow-right" />

          <p class="flex w-full justify-center gap-[6px] text-sm">
            <span class="text-ink-secondary">Not your account?</span>
            <button type="button" class="text-brand-navy font-semibold">Sign out</button>
          </p>
        </form>
      </section>
    </main>
  `,
})
export class SetNewPasswordPage {
  protected readonly rules = [
    { label: 'At least 10 characters', met: true },
    { label: 'An uppercase and a lowercase letter', met: true },
    { label: 'At least one number', met: true },
    { label: 'At least one symbol (!?@#$)', met: false },
  ];
}
