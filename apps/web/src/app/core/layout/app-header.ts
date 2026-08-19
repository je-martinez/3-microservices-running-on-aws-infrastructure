import { Component, input, output } from '@angular/core';
import { LucideBell, LucideSearch, LucideShoppingBag, LucideUser } from '@lucide/angular';
import { LogoLockup } from '../../shared/ui/logo-lockup';

/**
 * Design: merges `App Header` (EMNqu, 1440 desktop) and `Mobile App Header`
 * (fguH5, 390 mobile) into one responsive component per spec D8 — two
 * components here would double the count and guarantee divergence.
 *
 * Differences the `md:` breakpoint carries:
 *   - height 60px mobile -> 76px desktop; side padding 20px -> 48px.
 *   - icon buttons 40x40 mobile -> 44x44 desktop.
 *   - desktop shows the full "Search products" field (260x44); mobile
 *     collapses it to a bare search icon button (40x40) — same Search Icon
 *     glyph, no visible field or placeholder text on the smaller frame.
 *
 * Neither EMNqu nor fguH5 contains a hamburger/"Menu Sheet" trigger node —
 * both expose the same four actions (search, bell, profile, cart). No such
 * button is fabricated here; see the task report.
 */
@Component({
  selector: 'app-app-header',
  imports: [LogoLockup, LucideBell, LucideSearch, LucideShoppingBag, LucideUser],
  templateUrl: './app-header.html',
})
export class AppHeader {
  readonly cartCount = input(0);
  readonly hasUnreadNotifications = input(false);

  readonly searchClicked = output<void>();
  readonly notificationsClicked = output<void>();
  readonly profileClicked = output<void>();
  readonly cartClicked = output<void>();
}
