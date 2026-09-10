import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { Router } from '@angular/router';
import { LucideRefreshCw, LucideTriangleAlert } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import { OrdersApi } from '../../core/api/orders-api';
import type { OrderWithTracking } from '../../core/api/types';
import { authErrorMessage } from '../auth/auth-errors';
import { OrderCard } from '../../shared/ui/order-card';

/**
 * Design: `Orders — List` (`rGwBO`, 1040 desktop / `OoNex`, mobile). Filter
 * pills are presentational; each row reuses `OrderCard`.
 *
 * CONTRACT: Rows come from `OrdersApi.listMyOrders()`, which pins
 * `includeTracking=true`. Without it the route answers 200 with bare orders and
 * this list renders empty on success. See [[openapi-specs]]
 */
@Component({
  selector: 'app-orders-list',
  imports: [LucideRefreshCw, LucideTriangleAlert, OrderCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './orders-list.html',
})
export class OrdersListPage {
  private readonly router = inject(Router);
  private readonly ordersApi = inject(OrdersApi);

  protected readonly orders = signal<readonly OrderWithTracking[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly skeletons = [0, 1, 2];

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.orders.set(await firstValueFrom(this.ordersApi.listMyOrders()));
    } catch (error: unknown) {
      this.error.set(authErrorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected goTo(path: string): void {
    void this.router.navigateByUrl(path);
  }
}
