import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  LucideCheck,
  LucideChevronLeft,
  LucideCreditCard,
  LucideLock,
  LucideRefreshCw,
  LucideShieldCheck,
  LucideShoppingBag,
  LucideTriangleAlert,
} from '@lucide/angular';
import { APP_CONFIG } from '../../core/config/app-config';
import { toInt } from '../../core/api/types';
import { OrdersApi } from '../../core/api/orders-api';
import { CartStore } from '../../core/cart/cart-store';
import { authErrorMessage } from '../auth/auth-errors';
import { CartLine } from '../../shared/ui/cart-line';

/**
 * Design: `Checkout — Payment` (`DOtD2`, 1440) / `Mobile — Checkout Payment`
 * (`P0lhqj`). `App Header` + `Body` — a real page, unlike the cart overlays.
 * Loading, error and empty states use existing tokens: the `.pen` has no frame
 * for any of the three.
 *
 * CONTRACT: `APP_CONFIG.stripeEnabled` alone picks the payment path — false
 * renders this page's card fields (`checkout-plain`), true hands off to the
 * Stripe step in the cart drawer (`hed4V`, via `checkout-stripe`). Reaching
 * Stripe with the flag off exposes a path the build disabled.
 * See [[angular-component-authoring]]
 */
@Component({
  selector: 'app-checkout-payment',
  imports: [
    RouterLink,
    CartLine,
    LucideCheck,
    LucideChevronLeft,
    LucideCreditCard,
    LucideLock,
    LucideRefreshCw,
    LucideShieldCheck,
    LucideShoppingBag,
    LucideTriangleAlert,
  ],
  templateUrl: './checkout-payment.html',
})
export class CheckoutPaymentPage {
  private readonly ordersApi = inject(OrdersApi);
  private readonly router = inject(Router);

  protected readonly cart = inject(CartStore);

  /** Read from APP_CONFIG, never from import.meta.env — see app-config.ts. */
  protected readonly stripeEnabled = computed(() => APP_CONFIG.stripeEnabled);

  protected readonly placing = signal(false);
  protected readonly checkoutError = signal<string | null>(null);

  protected readonly itemCount = computed(() => this.cart.itemCount());

  /**
   * CONTRACT: Every figure here is the server's `formatted` string, rendered
   * verbatim. Re-deriving one from `cents` shows an amount a cent away from
   * what is actually charged — the server rounds tax per line.
   * See [[money-representation]]
   */
  protected readonly totals = computed(() => {
    const cart = this.cart.cart();
    if (!cart) return null;
    return {
      subtotal: cart.subtotal.formatted,
      tax: cart.tax.formatted,
      shipping: cart.shipping.formatted,
      total: cart.total.formatted,
    };
  });

  protected readonly canPay = computed(
    () => this.cart.canCheckout() && !this.cart.saving() && !this.placing(),
  );

  constructor() {
    void this.cart.load();
  }

  /**
   * CONTRACT: Send the cart's own lines explicitly — POST /orders does NOT read
   * the cart and answers 400 on an empty body. The server DELETES the cart on
   * success, so the local one is dropped rather than re-read.
   * See [[2026-09-04-web-gateway-integration-design]]
   */
  protected async pay(): Promise<void> {
    const lines = this.cart
      .lines()
      .filter((line) => line.available)
      .map((line) => ({ productId: line.productId, quantity: toInt(line.quantity) }));
    if (lines.length === 0) return;

    this.placing.set(true);
    this.checkoutError.set(null);
    try {
      const order = await firstValueFrom(this.ordersApi.createOrder(lines));
      this.cart.forgetAfterCheckout();
      await this.router.navigate(['/orders', order.id]);
    } catch (error: unknown) {
      // 409 is the race `canCheckout` cannot rule out: stock went in the gap
      // between reading the cart and charging it.
      this.checkoutError.set(
        authErrorMessage(error, {
          409: 'Someone bought the last one while you were checking out. Adjust your cart and try again.',
        }),
      );
      void this.cart.load();
    } finally {
      this.placing.set(false);
    }
  }
}
