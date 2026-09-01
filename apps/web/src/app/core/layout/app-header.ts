import { Component, input, output } from '@angular/core';
import { LucideBell, LucideSearch, LucideShoppingBag, LucideUser } from '@lucide/angular';
import { LogoLockup } from '../../shared/ui/logo-lockup';

/**
 * Design: `App Header` (EMNqu, 1440) and `Mobile App Header` (fguH5, 390) as one
 * responsive component per spec D8. The `md:` breakpoint carries the height,
 * padding, and icon-size deltas, and collapses the desktop search field to a
 * bare icon button on mobile.
 *
 * CONTRACT: Do NOT add a hamburger or menu-sheet trigger. Neither frame has one;
 * both expose exactly these four actions, so any extra control is invented UI.
 * See [[angular-component-authoring]]
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
