import { Component, computed } from '@angular/core';
import { LucideCheck, LucideChevronLeft, LucideCreditCard, LucideLock, LucideShieldCheck } from '@lucide/angular';
import { APP_CONFIG } from '../../core/config/app-config';
import { formatCents, toInt } from '../../fixtures/api-types';
import { PRODUCTS } from '../../fixtures/catalogue.fixture';
import { CartLine } from '../../shared/ui/cart-line';

/**
 * Design: `Checkout — Payment` (`DOtD2`, 1440) / `Mobile — Checkout Payment`
 * (`P0lhqj`). `App Header` + `Body` — a real page, unlike the cart overlays.
 *
 * CONTRACT: `APP_CONFIG.stripeEnabled` alone picks the payment path — false
 * renders this page's card fields (`checkout-plain`), true hands off to the
 * Stripe step in the cart drawer (`hed4V`, via `checkout-stripe`). Reaching
 * Stripe with the flag off exposes a path the build disabled. Phase 1 renders
 * both branches and submits neither; this repo has no payment backend.
 * See [[angular-component-authoring]]
 */
@Component({
  selector: 'app-checkout-payment',
  imports: [CartLine, LucideCheck, LucideChevronLeft, LucideCreditCard, LucideLock, LucideShieldCheck],
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
