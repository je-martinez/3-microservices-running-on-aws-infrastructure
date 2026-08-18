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
  template: `
    <div class="bg-surface-body flex h-fit min-h-screen w-full flex-col items-start justify-start gap-0">
      <app-app-header
        [hasUnreadNotifications]="hasUnreadNotifications"
        (notificationsClicked)="overlay.openNotifications()"
        (profileClicked)="overlay.openAccountMenu()"
        (cartClicked)="goTo('/')"
      />

      <div class="flex w-full flex-1 flex-col items-center justify-start gap-0 p-5 md:p-11">
        <div class="flex h-fit w-full max-w-[1040px] shrink-0 flex-col items-start justify-start gap-4 md:gap-6">
          <div class="flex h-fit w-full shrink-0 flex-col items-start justify-between gap-3 md:flex-row md:items-end">
            <div class="flex h-fit w-fit shrink-0 flex-col items-start justify-start gap-[3px] md:gap-[5px]">
              <h1 class="text-ink-primary text-2xl font-bold tracking-[-0.5px] md:text-[30px] md:tracking-[-0.8px]">
                My orders
              </h1>
              <p class="text-ink-secondary text-[13px] md:text-[15px]">
                {{ orders.length }} order{{ orders.length === 1 ? '' : 's' }} in the last 90 days
              </p>
            </div>

            <div class="flex h-fit w-full flex-row flex-wrap items-center justify-start gap-2 md:w-fit md:gap-[10px]">
              <span
                class="bg-brand-navy border-brand-navy text-surface-white flex h-[38px] w-fit shrink-0 flex-row items-center justify-start rounded-full border px-[14px] text-[13.5px] font-semibold md:px-[17px]"
              >
                All
              </span>
              <span
                class="border-line-strong text-ink-secondary flex h-[38px] w-fit shrink-0 flex-row items-center justify-start rounded-full border px-[14px] text-[13.5px] md:px-[17px]"
              >
                In progress
              </span>
              <span
                class="border-line-strong text-ink-secondary flex h-[38px] w-fit shrink-0 flex-row items-center justify-start rounded-full border px-[14px] text-[13.5px] md:px-[17px]"
              >
                Delivered
              </span>
            </div>
          </div>

          <div class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-3 md:gap-4">
            @for (entry of orders; track entry.order.id) {
              <button type="button" class="w-full text-left" (click)="goTo('/orders/' + entry.order.id)">
                <app-order-card [entry]="entry" />
              </button>
            } @empty {
              <p class="text-ink-secondary w-full py-10 text-center text-sm">No orders yet.</p>
            }
          </div>
        </div>
      </div>
    </div>
  `,
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
