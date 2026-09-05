import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ORDERS } from '../../fixtures/orders.fixture';
import { OrderCard } from '../../shared/ui/order-card';

/**
 * Design: `Orders — List` (`rGwBO`, 1040 desktop / `OoNex`, mobile). The filter
 * pills are presentational in Phase 1; each row reuses `OrderCard`. The header
 * above comes from `AppLayout`; `goTo` serves this page's own order rows.
 */
@Component({
  selector: 'app-orders-list',
  imports: [OrderCard],
  templateUrl: './orders-list.html',
})
export class OrdersListPage {
  private readonly router = inject(Router);

  protected readonly orders = ORDERS;

  protected goTo(path: string): void {
    void this.router.navigateByUrl(path);
  }
}
