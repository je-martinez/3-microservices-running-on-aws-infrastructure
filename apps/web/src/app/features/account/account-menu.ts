import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { LucideLogOut, LucidePackage, LucideUser } from '@lucide/angular';
import { OverlayStore } from '../../core/overlay/overlay-store';
import { CURRENT_USER } from '../../fixtures/user.fixture';

/**
 * Design: `Account Menu` (`B6fdc`), covering the `H2A9g`/`pD15E` frame pair.
 *
 * ONE responsive component (spec D8), not two — the desktop and mobile
 * frames diverge more than most pairs in this app, so both shapes live in
 * one template switched by the `md:` breakpoint rather than by two
 * components:
 *   - Desktop (`H2A9g`): a `w-[260px]` dropdown anchored under the header's
 *     profile button, `top-[86px] right-6`, no scrim of its own (the shared
 *     cart `Scrim` never renders for `'account-menu'` — `hasScrim` stays
 *     false).
 *   - Mobile (`pD15E`, node `b24pOK` "Menu Sheet"): a full-width bottom
 *     sheet — `rounded-[22px_22px_0px_0px]`, a grabber handle, larger rows
 *     (50px vs. 42px) — with its OWN full-bleed scrim (`#12161FA6` in the
 *     design), separate from the shared cart Scrim and NOT reflected in
 *     `OverlayStore.hasScrim` (still correctly false — this scrim belongs to
 *     the menu, not the store's cart-only concept).
 *
 * Both layers sit at `z-50`, above the shared cart Scrim's `z-40` — the
 * cart Scrim never renders here regardless, but the menu must still clear
 * anything else that might.
 *
 * `#12161FA6` (the mobile scrim colour) has no matching DESIGN.md token —
 * flagged in the task report rather than hand-added as a new hex. This
 * component reuses the same non-token idiom the shared `Scrim` component
 * already uses (`bg-black/40`) at a closer opacity (`/65`) instead of
 * inventing a new arbitrary colour class.
 */
@Component({
  selector: 'app-account-menu',
  imports: [LucideLogOut, LucidePackage, LucideUser],
  template: `
    <!-- Mobile: full-bleed scrim behind the sheet, dismisses on click. -->
    <div
      class="fixed inset-0 z-50 bg-black/65 md:hidden"
      role="presentation"
      (click)="overlay.close()"
    ></div>

    <div
      class="border-line bg-surface-white fixed inset-x-0 bottom-0 z-50 flex h-fit w-full flex-col items-start justify-start gap-[6px] rounded-t-[22px] border-t p-3 pb-[26px] shadow-[0px_-8px_32px_0px_#1A1A2E33] md:inset-x-auto md:top-[86px] md:right-6 md:bottom-auto md:w-[260px] md:gap-[2px] md:rounded-xl md:border md:p-2 md:pb-2 md:shadow-[0px_12px_32px_0px_#1A1A2E29]"
    >
      <!-- Grabber: mobile-only affordance, absent from the desktop dropdown. -->
      <div class="flex h-fit w-full shrink-0 flex-row items-center justify-center p-[4px_0px_8px_0px] md:hidden">
        <div class="bg-line-strong h-1 w-10 shrink-0 rounded-full"></div>
      </div>

      <div class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-[3px] p-[6px_12px_12px_12px] md:p-[10px_12px]">
        <div class="text-ink-primary text-base font-semibold whitespace-nowrap md:text-[14.5px]">{{ user.fullName }}</div>
        <div class="text-ink-secondary text-[13.5px] whitespace-nowrap md:text-[13px]">{{ user.email }}</div>
      </div>

      <div class="bg-line h-px w-full shrink-0"></div>

      <button
        type="button"
        class="bg-surface-subtle flex h-[50px] w-full shrink-0 flex-row items-center justify-start gap-[11px] rounded-lg px-3 md:h-[42px]"
        (click)="goTo('/profile')"
      >
        <svg lucideUser class="text-ink-primary h-[19px] w-[19px] md:h-[17px] md:w-[17px]"></svg>
        <span class="text-ink-primary text-[15px] md:text-sm">Profile</span>
      </button>

      <button
        type="button"
        class="flex h-[50px] w-full shrink-0 flex-row items-center justify-start gap-[11px] rounded-lg px-3 md:h-[42px]"
        (click)="goTo('/orders')"
      >
        <svg lucidePackage class="text-ink-primary h-[19px] w-[19px] md:h-[17px] md:w-[17px]"></svg>
        <span class="text-ink-primary text-[15px] md:text-sm">My orders</span>
      </button>

      <div class="bg-line h-px w-full shrink-0"></div>

      <button
        type="button"
        class="flex h-[50px] w-full shrink-0 flex-row items-center justify-start gap-[11px] rounded-lg px-3 md:h-[42px]"
        (click)="signOut()"
      >
        <svg lucideLogOut class="text-danger-red h-[19px] w-[19px] md:h-[17px] md:w-[17px]"></svg>
        <span class="text-danger-red text-[15px] font-semibold md:text-sm">Sign out</span>
      </button>
    </div>
  `,
})
export class AccountMenu {
  protected readonly overlay = inject(OverlayStore);
  private readonly router = inject(Router);

  protected readonly user = CURRENT_USER;

  protected goTo(path: string): void {
    this.overlay.close();
    void this.router.navigateByUrl(path);
  }

  protected signOut(): void {
    // Phase 1 has no auth session to tear down — closing the menu matches
    // the design's affordance without a real sign-out flow behind it yet.
    this.overlay.close();
  }
}
