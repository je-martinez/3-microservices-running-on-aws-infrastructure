import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AppHeader } from '../../core/layout/app-header';
import { OverlayStore } from '../../core/overlay/overlay-store';
import { NOTIFICATIONS } from '../../fixtures/notifications.fixture';
import { ORDERS } from '../../fixtures/orders.fixture';
import { OrderCard } from '../../shared/ui/order-card';

/**
 * Design: `Orders — List` (`rGwBO`, 1040 desktop / `OoNex`, mobile). The filter
 * pills are presentational in Phase 1; each row reuses `OrderCard`.
 *
 * CONTRACT: The cart button here navigates to `/` rather than opening the
 * overlay. `CartDrawer` mounts only in `HomePage`, so opening it from this route
 * sets overlay state that nothing renders. `AccountMenu` and
 * `NotificationsPanel` mount in `Shell` and do work from any route.
 * See [[angular-component-authoring]]
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
