import { Component, computed } from '@angular/core';
import { LucideCheck, LucideChevronLeft, LucideCreditCard, LucideLock, LucideShieldCheck } from '@lucide/angular';
import { APP_CONFIG } from '../../core/config/app-config';
import { AppHeader } from '../../core/layout/app-header';
import { formatCents, toInt } from '../../fixtures/api-types';
import { PRODUCTS } from '../../fixtures/catalogue.fixture';
import { CartLine } from '../../shared/ui/cart-line';

/**
 * Design: `Checkout — Payment` (`DOtD2`, 1440) / `Mobile — Checkout Payment`
 * (`P0lhqj`). `App Header` + `Body` — a real page, unlike the cart overlays.
 *
 * Two payment paths exist in the design and `APP_CONFIG.stripeEnabled`
 * decides which one the user gets:
 *   - `false` -> this page's own card fields (`data-testid="checkout-plain"`)
 *   - `true`  -> the Stripe step, laid out in the cart drawer (`hed4V`),
 *     reached via `data-testid="checkout-stripe"` here as a hand-off panel
 *
 * Phase 1 renders both branches and submits neither — no payment backend
 * exists anywhere in this repo (no service, no Terraform, no `.env`).
 */
@Component({
  selector: 'app-checkout-payment',
  imports: [AppHeader, CartLine, LucideCheck, LucideChevronLeft, LucideCreditCard, LucideLock, LucideShieldCheck],
  templateUrl: './checkout-payment.html',
})
export class CheckoutPaymentPage {
  /** Read from APP_CONFIG, never from import.meta.env — see app-config.ts. */
  protected readonly stripeEnabled = computed(() => APP_CONFIG.stripeEnabled);

  protected readonly cartItems = PRODUCTS.slice(0, 3);
  protected readonly itemCount = computed(() => this.cartItems.length);
  protected readonly total = computed(
    () => `$${formatCents(this.cartItems.reduce((sum, product) => sum + toInt(product.unitPriceCents), 0))}`,
  );
}
