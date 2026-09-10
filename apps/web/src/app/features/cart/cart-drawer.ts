import { Component, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { Router } from '@angular/router';
import {
  LucideArrowRight,
  LucideRefreshCw,
  LucideShieldCheck,
  LucideShoppingBag,
  LucideTriangleAlert,
  LucideX,
} from '@lucide/angular';
import { DeferEnterAnimation } from '../../core/overlay/defer-enter-animation';
import { OverlayStore } from '../../core/overlay/overlay-store';
import { type CartLine as CartLineDto, toInt } from '../../core/api/types';
import { CartStore } from '../../core/cart/cart-store';
import { CartLine } from '../../shared/ui/cart-line';

/**
 * Design: `Cart Drawer` (`ET6dr`), the saved-address frame (`wevx6`) reduced to
 * its cart half. Loading, error and empty states use existing tokens: the
 * `.pen` has no frame for any of the three.
 *
 * CONTRACT: This drawer holds items and NEVER places an order — `Continue`
 * routes to `/checkout`, which owns the address and POST /orders. A drawer that
 * checks out too gives one purchase two implementations, and the one the buyer
 * did not use silently stops matching. This panel stays `z-50`, above its
 * Scrim's `z-40`, or it renders underneath.
 * See [[angular-component-authoring]]
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
    LucideArrowRight,
    LucideRefreshCw,
    LucideShieldCheck,
    LucideShoppingBag,
    LucideTriangleAlert,
    LucideX,
  ],
  templateUrl: './cart-drawer.html',
  hostDirectives: [DeferEnterAnimation],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'animate.enter': 'drawer-enter',
    'animate.leave': 'drawer-leave',
  },
})
export class CartDrawer {
  private readonly router = inject(Router);

  protected readonly overlay = inject(OverlayStore);
  protected readonly cart = inject(CartStore);

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

  /**
   * CONTRACT: `canCheckout` gates the button but never guarantees the order
   * succeeds — another buyer can take the last unit before checkout charges.
   * The failure branch lives in CheckoutPaymentPage, which does the charging.
   */
  protected readonly canContinue = computed(() => this.cart.canCheckout() && !this.cart.saving());

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

  /**
   * CONTRACT: Close the overlay as well as navigating. `/checkout` is a routed
   * page under the same layout, so a drawer left open covers the page the
   * buyer was just sent to, over a scrim that blocks it.
   */
  protected continue(): void {
    this.overlay.close();
    void this.router.navigate(['/checkout']);
  }
}
