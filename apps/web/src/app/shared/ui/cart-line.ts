import { Component, computed, input, output } from '@angular/core';
import { LucideMinus, LucidePlus } from '@lucide/angular';
import { formatCents, type Product, toInt } from '../../fixtures/api-types';

/**
 * Design: frame `Cart Line` (L5XVFs, 372px wide), reused in `Cart Drawer`
 * (`ET6dr`) and `Checkout — Payment`'s Order Summary card (`DOtD2`).
 *
 * No OrderLine/cart-item contract exists yet — Phase 1 has no cart store —
 * so this renders straight off a `Product` plus a `quantity` count, computing
 * the line total itself (`unitPriceCents` is `IntLike`, never arithmetic'd
 * directly). The design's "Size 42 · Sand" variant text has no backing field
 * on `ProductDto`; the product's first category stands in as the line's
 * descriptor, matching `ProductCard`'s own category chip.
 */
@Component({
  selector: 'app-cart-line',
  imports: [LucideMinus, LucidePlus],
  templateUrl: './cart-line.html',
})
export class CartLine {
  readonly product = input.required<Product>();
  readonly quantity = input(1);

  readonly increment = output<void>();
  readonly decrement = output<void>();

  protected readonly variant = computed(() => this.product().categories[0]?.toUpperCase());
  protected readonly linePrice = computed(
    () => `$${formatCents(toInt(this.product().unitPriceCents) * this.quantity())}`,
  );
}
