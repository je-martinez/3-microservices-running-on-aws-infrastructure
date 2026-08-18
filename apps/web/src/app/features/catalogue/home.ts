import { Component, inject } from '@angular/core';
import { LucideChevronDown } from '@lucide/angular';
import { AppHeader } from '../../core/layout/app-header';
import { OverlayStore } from '../../core/overlay/overlay-store';
import { PRODUCTS } from '../../fixtures/catalogue.fixture';
import { NOTIFICATIONS } from '../../fixtures/notifications.fixture';
import { CURRENT_USER } from '../../fixtures/user.fixture';
import { ProductCard } from '../../shared/ui/product-card';
import { CartDrawer } from '../cart/cart-drawer';

/**
 * Design: `Home — Products` (`eK0x6` desktop / `ffO4d` mobile). `App Header`
 * + `Body` — a real page, unlike the overlay frames also anchored here (see
 * DESIGN.md "Overlays are not routes"). The `Body`'s Toolbar (title, filter
 * pills, sort) is presentational only in Phase 1 — no filter/sort state
 * exists yet, matching the fixture's flat product list.
 *
 * `CartDrawer` mounts here off `OverlayStore.active()`; `AccountMenu` and
 * `NotificationsPanel` are Task 11's panels and mount in `Shell` instead.
 */
@Component({
  selector: 'app-home',
  imports: [AppHeader, CartDrawer, LucideChevronDown, ProductCard],
  template: `
    <div class="bg-surface-white flex h-fit w-full flex-col items-start justify-start gap-0 overflow-hidden">
      <app-app-header
        [hasUnreadNotifications]="hasUnreadNotifications"
        (notificationsClicked)="overlay.openNotifications()"
        (profileClicked)="overlay.openAccountMenu()"
        (cartClicked)="overlay.openCart()"
      />

      <div class="bg-surface-white flex w-full flex-1 flex-col items-start justify-start gap-5 p-5 md:gap-7 md:p-9">
        <div class="flex h-fit w-full shrink-0 flex-col items-start justify-between gap-4 md:flex-row md:items-end md:gap-0">
          <div class="flex h-fit w-fit shrink-0 flex-col items-start justify-start gap-[5px]">
            <h1 class="text-ink-primary text-2xl font-bold tracking-[-0.7px] md:text-[28px]">New arrivals</h1>
            <p class="text-ink-secondary text-sm">{{ products.length }} products · updated today</p>
          </div>
          <div class="flex h-fit w-full flex-row flex-wrap items-center justify-start gap-[10px] md:w-fit">
            <span class="bg-brand-navy border-brand-navy text-surface-white flex h-[38px] w-fit shrink-0 flex-row items-center justify-start rounded-full border px-[17px] text-[13.5px] font-semibold">
              All
            </span>
            @for (category of categories; track category) {
              <span class="border-line-strong text-ink-secondary flex h-[38px] w-fit shrink-0 flex-row items-center justify-start rounded-full border px-[17px] text-[13.5px]">
                {{ category }}
              </span>
            }
            <span class="border-line-strong text-ink-primary flex h-[38px] w-fit shrink-0 flex-row items-center justify-start gap-2 rounded-full border px-[14px] text-[13.5px]">
              Featured
              <svg lucideChevronDown class="text-ink-secondary h-[15px] w-[15px]"></svg>
            </span>
          </div>
        </div>

        <div class="grid w-full grid-cols-2 gap-3 md:grid-cols-4 md:gap-6">
          @for (product of products; track product.id) {
            <app-product-card [product]="product" />
          }
        </div>
      </div>
    </div>

    @if (overlay.active() === 'cart' || overlay.active() === 'cart-payment') {
      <app-cart-drawer
        [step]="overlay.active() === 'cart-payment' ? 'payment' : 'cart'"
        [address]="savedAddress"
      />
    }
  `,
})
export class HomePage {
  protected readonly overlay = inject(OverlayStore);
  protected readonly products = PRODUCTS;
  protected readonly categories = ['Footwear', 'Bags', 'Accessories'];

  // Phase 1 has no address/profile store yet, so the saved-address state
  // (the primary design, per DESIGN.md) reads the populated address off the
  // user fixture. Phase 2 reads it from the real profile store instead.
  protected readonly savedAddress = CURRENT_USER.address;

  // Drives the bell's unread dot (AppHeader's `hasUnreadNotifications`
  // input) straight off the fixture — Phase 1 has no notifications store.
  protected readonly hasUnreadNotifications = NOTIFICATIONS.some((n) => !n.read);
}
