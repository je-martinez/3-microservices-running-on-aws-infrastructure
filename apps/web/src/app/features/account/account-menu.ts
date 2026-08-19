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
 * The mobile sheet carries its own scrim: `hasScrim` is false for
 * 'account-menu' (the shared cart Scrim never renders here), yet the design
 * still dims the page behind the sheet. Both use the same `bg-scrim` token.
 */
@Component({
  selector: 'app-account-menu',
  imports: [LucideLogOut, LucidePackage, LucideUser],
  templateUrl: './account-menu.html',
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
