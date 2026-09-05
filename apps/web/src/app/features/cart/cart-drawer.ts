import { Component, computed, inject, input, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  LucideBuilding2,
  LucideChevronLeft,
  LucideCreditCard,
  LucideDynamicIcon,
  LucideMapPin,
  LucidePhone,
  LucideRefreshCw,
  LucideShieldCheck,
  LucideShoppingBag,
  LucideTriangleAlert,
  LucideX,
} from '@lucide/angular';
import { APP_CONFIG } from '../../core/config/app-config';
import { DeferEnterAnimation } from '../../core/overlay/defer-enter-animation';
import { OverlayStore } from '../../core/overlay/overlay-store';
import { type Address, type CartLine as CartLineDto, toInt } from '../../core/api/types';
import { OrdersApi } from '../../core/api/orders-api';
import { CartStore } from '../../core/cart/cart-store';
import { authErrorMessage } from '../auth/auth-errors';
import { CartLine } from '../../shared/ui/cart-line';

/**
 * Design: `Cart Drawer` (`ET6dr`). ONE component (spec D8) for three frame pairs
 * that differ only by state: cart with a saved address (`wevx6`), cart without
 * one (`eig49`, inline address form), and the Stripe payment step (`hed4V`).
 * Loading, error and empty states use existing tokens: the `.pen` has no frame
 * for any of the three.
 *
 * CONTRACT: The payment step opens only when `APP_CONFIG.stripeEnabled` is true
 * — a build with Stripe off must not reach a step it has disabled (spec
 * D-checkout). This panel stays `z-50`, above its Scrim's `z-40`, or it renders
 * underneath. See [[angular-component-authoring]]
 */

/**
 * CONTRACT: The animation binds on the HOST, not the `<aside>`. HomePage removes
 * this with `@if`, and `animate.leave` runs only on the removed element or a
 * descendant of the SAME template — a binding on the panel never fires.
 *
 * CONTRACT: Do NOT give the host a `transform`; `.drawer-enter > *` slides the
 * `fixed` panel instead. A transformed host becomes that panel's containing
 * block, re-anchoring it out of the viewport. See [[angular-component-authoring]]
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
    LucideRefreshCw,
    LucideShieldCheck,
    LucideShoppingBag,
    LucideTriangleAlert,
    LucideX,
  ],
  templateUrl: './cart-drawer.html',
  hostDirectives: [DeferEnterAnimation],
  host: {
    'class': 'block',
    'animate.enter': 'drawer-enter',
    'animate.leave': 'drawer-leave',
  },
})
export class CartDrawer {
  readonly address = input<Address | null>(null);
  readonly step = input<'cart' | 'payment'>('cart');

  private readonly ordersApi = inject(OrdersApi);

  protected readonly overlay = inject(OverlayStore);
  protected readonly cart = inject(CartStore);

  /** Set while POST /orders is in flight, and by its failure. */
  protected readonly placing = signal(false);
  protected readonly checkoutError = signal<string | null>(null);

  protected readonly itemCount = computed(() => this.cart.itemCount());

  /**
   * CONTRACT: These render the server's `formatted` strings verbatim. Rebuilding
   * a total from `cents` shows a figure a cent away from what checkout charges,
   * because the server rounds tax per line. See [[money-representation]]
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

  protected readonly continueLabel = computed(() => {
    if (this.step() === 'payment') return `Pay ${this.totals()?.total ?? ''}`.trim();
    return this.address() ? 'Continue to payment' : 'Save address & continue';
  });

  /**
   * CONTRACT: `canCheckout` gates the button but never guarantees success —
   * another buyer can take the last unit between the cart read and POST
   * /orders. The failure branch in `placeOrder` is the one that matters.
   */
  protected readonly canContinue = computed(
    () => this.cart.canCheckout() && !this.cart.saving() && !this.placing(),
  );

  constructor() {
    void this.cart.load();
  }

  // CONTRACT: Coerce `quantity` with toInt — it is IntLike, so `+ 1` on the
  // string form concatenates and PUTs a quantity of "21" for 2 plus one.
  protected increment(line: CartLineDto): void {
    void this.cart.setQuantity(line.productId, toInt(line.quantity) + 1);
  }

  protected decrement(line: CartLineDto): void {
    void this.cart.setQuantity(line.productId, toInt(line.quantity) - 1);
  }

  protected remove(line: CartLineDto): void {
    void this.cart.remove(line.productId);
  }

  protected continue(): void {
    if (this.step() === 'payment') {
      void this.placeOrder();
      return;
    }
    if (APP_CONFIG.stripeEnabled) {
      this.overlay.openCartPayment();
      return;
    }
    void this.placeOrder();
  }

  /**
   * CONTRACT: Send the cart's own lines explicitly — POST /orders does NOT read
   * the cart and answers 400 on an empty body. On success the server has
   * already DELETED the cart, so the local one is dropped rather than re-read.
   * See [[2026-09-04-web-gateway-integration-design]]
   */
  private async placeOrder(): Promise<void> {
    const lines = this.cart
      .lines()
      .filter((line) => line.available)
      .map((line) => ({ productId: line.productId, quantity: toInt(line.quantity) }));
    if (lines.length === 0) return;

    this.placing.set(true);
    this.checkoutError.set(null);
    try {
      await firstValueFrom(this.ordersApi.createOrder(lines));
      this.cart.forgetAfterCheckout();
      this.overlay.close();
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
