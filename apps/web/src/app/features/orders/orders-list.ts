import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AppHeader } from '../../core/layout/app-header';
import { OverlayStore } from '../../core/overlay/overlay-store';
import { NOTIFICATIONS } from '../../fixtures/notifications.fixture';
import { ORDERS } from '../../fixtures/orders.fixture';
import { OrderCard } from '../../shared/ui/order-card';

/**
 * Design: `Orders — List` (`rGwBO`, 1040 desktop / `OoNex`, mobile).
 *
 * The filter pills ("All" / "In progress" / "Delivered") are presentational
 * only in Phase 1, matching Home's Toolbar pills (Task 10) — no filter state
 * exists yet, so the list always renders the full `ORDERS` fixture.
 *
 * Each row reuses `OrderCard` (Task 11's own `l6TyrG`/`tWTSZ` component) —
 * the catalogue join it performs is not duplicated here.
 *
 * The header's bell/profile actions open `AccountMenu`/`NotificationsPanel`
 * off `OverlayStore` — both mount in `Shell` (global) so they work from any
 * route. `CartDrawer` mounts only in `HomePage` (Task 10), so the cart
 * button instead navigates to `/`, where it can actually open.
 */
@Component({
  selector: 'app-orders-list',
  imports: [AppHeader, OrderCard],
  templateUrl: './orders-list.html',
})
export class OrdersListPage {
  private readonly router = inject(Router);
  protected readonly overlay = inject(OverlayStore);

  protected readonly orders = ORDERS;
  protected readonly hasUnreadNotifications = NOTIFICATIONS.some((n) => !n.read);

  protected goTo(path: string): void {
    void this.router.navigateByUrl(path);
  }
}
