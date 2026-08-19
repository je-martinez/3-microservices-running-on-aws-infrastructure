import { Component, computed, inject, input } from '@angular/core';
import {
  LucideBuilding2,
  LucideChevronLeft,
  LucideCreditCard,
  LucideDynamicIcon,
  LucideMapPin,
  LucidePhone,
  LucideShieldCheck,
  LucideX,
} from '@lucide/angular';
import { APP_CONFIG } from '../../core/config/app-config';
import { OverlayStore } from '../../core/overlay/overlay-store';
import { type Address, formatCents, type Product, toInt } from '../../fixtures/api-types';
import { PRODUCTS } from '../../fixtures/catalogue.fixture';
import { CartLine } from '../../shared/ui/cart-line';

/**
 * Design: `Cart Drawer` (`ET6dr`). ONE component covers three frame pairs
 * (spec D8) — they differ only by state, never by structure:
 *   - `Home — Cart Open (saved address)` (`wevx6`/`OIjLT`) — `step: "cart"`,
 *     `address` set.
 *   - `Home — Cart Open (no address)` (`eig49`/`KzgZN`) — `step: "cart"`,
 *     `address` null: renders the inline address form instead of the
 *     "Deliver to" card.
 *   - `Home — Cart Payment (Stripe)` (`hed4V`/`NfXeq`) — `step: "payment"`.
 *     Reachable only when `APP_CONFIG.stripeEnabled` is true; the build
 *     cannot open a step it has disabled (spec D-checkout).
 *
 * Mounts off `OverlayStore` in `Home`, ABOVE its own Scrim (`z-40`) — this
 * panel is `z-50`, or it would render underneath the scrim meant to sit
 * behind it (see task-10-brief.md).
 *
 * No cart store exists in Phase 1: cart contents are the first three
 * fixture products, mirroring how `Home` renders the flat fixture catalogue.
 */
@Component({
  selector: 'app-cart-drawer',
  imports: [
    CartLine,
    LucideBuilding2,
    LucideChevronLeft,
    LucideCreditCard,
    LucideDynamicIcon,
    LucideMapPin,
    LucidePhone,
    LucideShieldCheck,
    LucideX,
  ],
  templateUrl: './cart-drawer.html',
})
export class CartDrawer {
  readonly address = input<Address | null>(null);
  readonly step = input<'cart' | 'payment'>('cart');

  protected readonly overlay = inject(OverlayStore);
  protected readonly cartItems: readonly Product[] = PRODUCTS.slice(0, 3);

  protected readonly subtotal = computed(() =>
    `$${formatCents(this.cartItems.reduce((sum, product) => sum + toInt(product.unitPriceCents), 0))}`,
  );

  protected readonly continueLabel = computed(() => {
    if (this.step() === 'payment') return `Pay ${this.subtotal()}`;
    return this.address() ? 'Continue to payment' : 'Save address & continue';
  });

  // The Stripe step only exists in the build when the flag enables it — the
  // drawer cannot reach `cart-payment` otherwise (spec D-checkout).
  protected continue(): void {
    if (this.step() === 'payment') return; // Neither path submits (no payment backend).
    if (APP_CONFIG.stripeEnabled) {
      this.overlay.openCartPayment();
    }
  }
}
