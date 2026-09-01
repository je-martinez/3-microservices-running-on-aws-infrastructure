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
 * Design: `Home — Products` (`eK0x6` desktop / `ffO4d` mobile) — a real page of
 * `App Header` + `Body`, unlike the overlay frames also anchored here. The
 * Toolbar is presentational in Phase 1. `CartDrawer` mounts here off
 * `OverlayStore.active()`; the other two panels mount in `Shell`.
 */
@Component({
  selector: 'app-home',
  imports: [AppHeader, CartDrawer, LucideChevronDown, ProductCard],
  templateUrl: './home.html',
})
export class HomePage {
  protected readonly overlay = inject(OverlayStore);
  protected readonly products = PRODUCTS;
  protected readonly categories = ['Footwear', 'Bags', 'Accessories'];

  // Phase 1 has no profile store, so the saved-address state (the primary
  // design, per DESIGN.md) reads the populated address off the user fixture.
  protected readonly savedAddress = CURRENT_USER.address;

  // Drives the bell's unread dot (AppHeader's `hasUnreadNotifications`
  // input) straight off the fixture — Phase 1 has no notifications store.
  protected readonly hasUnreadNotifications = NOTIFICATIONS.some((n) => !n.read);
}
