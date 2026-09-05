import { Component, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { NOTIFICATIONS } from '../../fixtures/notifications.fixture';
import { OverlayStore } from '../overlay/overlay-store';
import { AppHeader } from './app-header';

/**
 * CONTRACT: Each routed page keeps its OWN outer wrapper. The backgrounds and
 * heights differ per screen — `/` is `bg-surface-white`, the orders and profile
 * screens are `bg-surface-body` — so hoisting one wrapper up here repaints them.
 * This layout owns only the header and the `min-h-screen` column that lets a
 * page's `flex-1` fill the space below it. See [[angular-component-authoring]]
 */
@Component({
  selector: 'app-app-layout',
  imports: [AppHeader, RouterOutlet],
  templateUrl: './app-layout.html',
})
export class AppLayout {
  private readonly router = inject(Router);
  protected readonly overlay = inject(OverlayStore);

  // Drives the bell's unread dot straight off the fixture — Phase 1 has no
  // notifications store.
  protected readonly hasUnreadNotifications = NOTIFICATIONS.some((n) => !n.read);

  /**
   * CONTRACT: The cart opens as an overlay ONLY on `/`. `CartDrawer` mounts in
   * `HomePage` alone, so setting 'cart' from any other route leaves `active`
   * holding a panel nothing renders — the button looks broken and the scrim
   * never appears. Navigating home first is what makes the drawer reachable.
   * See [[angular-component-authoring]]
   */
  protected openCart(): void {
    if (this.router.url.split('?')[0] === '/') {
      this.overlay.openCart();
      return;
    }
    void this.router.navigateByUrl('/');
  }
}
