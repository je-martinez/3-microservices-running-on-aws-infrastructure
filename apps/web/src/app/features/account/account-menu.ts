import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { LucideLogOut, LucidePackage, LucideUser } from '@lucide/angular';
import { OverlayStore } from '../../core/overlay/overlay-store';
import { CURRENT_USER } from '../../fixtures/user.fixture';

/**
 * Design: `Account Menu` (`B6fdc`) — one responsive component (spec D8) for the
 * `H2A9g` desktop dropdown and the `pD15E` mobile bottom sheet.
 *
 * CONTRACT: This component renders its OWN scrim for the mobile sheet.
 * `OverlayStore.hasScrim` is false for 'account-menu' — correctly, since that
 * flag tracks the shared cart Scrim only — so removing the local scrim leaves
 * the sheet undimmed. Both layers stay `z-50`, above that Scrim's `z-40`.
 * See [[angular-component-authoring]]
 */

/**
 * CONTRACT: The animation binds on the HOST, not the two root divs. Shell
 * removes this component with `@if`, and Angular runs `animate.leave` only on
 * the removed element or a descendant of the SAME template — a binding on an
 * inner div is another template and never fires. The host also fades the local
 * scrim with the sheet, which two bindings would let drift apart.
 * See [[angular-component-authoring]]
 */

/**
 * CONTRACT: Do NOT give the host a `transform`; the popover keyframes slide the
 * root divs via a `.popover-* > *` rule instead. A transformed host becomes the
 * containing block for these `fixed` layers, growing the document to reach it —
 * the scrollbar thumb visibly resizes on every open.
 * See [[angular-component-authoring]]
 */
@Component({
  selector: 'app-account-menu',
  imports: [LucideLogOut, LucidePackage, LucideUser],
  templateUrl: './account-menu.html',
  host: {
    'class': 'block',
    'animate.enter': 'popover-enter',
    'animate.leave': 'popover-leave',
  },
})
export class AccountMenu {
  protected readonly overlay = inject(OverlayStore);
  private readonly router = inject(Router);

  protected readonly user = CURRENT_USER;

  /**
   * WHY: Derived from the router rather than a static class in the template.
   * The design frame ships `Profile` pre-highlighted, so a hardcoded class
   * leaves it lit on every route, including `/orders`.
   */
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );

  protected readonly isActive = computed(() => {
    const path = this.url().split('?')[0].split('#')[0];
    return (route: string) => path === route;
  });

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
