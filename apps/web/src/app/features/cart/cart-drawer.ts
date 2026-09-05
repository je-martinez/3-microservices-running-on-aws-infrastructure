import { Component, computed, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';
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
import { DeferEnterAnimation } from '../../core/overlay/defer-enter-animation';
import { OverlayStore } from '../../core/overlay/overlay-store';
import { type Address, type Product, toInt } from '../../core/api/types';
import { CatalogueApi } from '../../core/api/catalogue-api';
import { formatCentsAsUsd } from '../../shared/money/format-money';
import { CartLine } from '../../shared/ui/cart-line';

/**
 * Design: `Cart Drawer` (`ET6dr`). ONE component (spec D8) for three frame pairs
 * that differ only by state: cart with a saved address (`wevx6`), cart without
 * one (`eig49`, inline address form), and the Stripe payment step (`hed4V`).
 * Phase 1 has no cart store; contents are the first three fixture products.
 *
 * CONTRACT: The payment step opens only when `APP_CONFIG.stripeEnabled` is true
 * — a build with Stripe off must not reach a step it has disabled (spec
 * D-checkout). This panel stays `z-50`, above its Scrim's `z-40`, or it renders
 * underneath the scrim meant to sit behind it.
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

  protected readonly overlay = inject(OverlayStore);

  /**
   * TODO(JE-245): Replace with GET /cart. This issue wires the catalogue,
   * orders and profile only; there is no cart store yet, so the drawer keeps
   * showing three products as its stand-in contents — now real ones, so it
   * cannot outlive the deleted fixture.
   */
  private readonly catalogue = toSignal(
    inject(CatalogueApi)
      .listProducts()
      .pipe(catchError(() => of<Product[]>([]))),
    { initialValue: [] as Product[] },
  );

  protected readonly cartItems = computed<readonly Product[]>(() => this.catalogue().slice(0, 3));

  protected readonly subtotal = computed(() =>
    formatCentsAsUsd(this.cartItems().reduce((sum, p) => sum + toInt(p.unitPrice.cents), 0)),
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
