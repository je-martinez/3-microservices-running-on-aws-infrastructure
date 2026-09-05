import { Component, computed, input, output } from '@angular/core';
import { LucideMinus, LucidePlus } from '@lucide/angular';
import { formatCents, type Product, toInt } from '../../fixtures/api-types';

/**
 * Design: frame `Cart Line` (L5XVFs), reused in `Cart Drawer` (`ET6dr`) and
 * `Checkout — Payment`'s Order Summary (`DOtD2`). With no cart contract yet, it
 * renders off a `Product` plus a `quantity`. The design's variant text has no
 * backing field, so the first category stands in as the descriptor.
 *
 * CONTRACT: `unitPriceCents` is `IntLike` — coerce it with `toInt` before any
 * arithmetic, or a string price silently concatenates into the line total.
 * See [[money-as-integer-cents]]
 */
@Component({
  selector: 'app-cart-line',
  imports: [LucideMinus, LucidePlus],
  templateUrl: './cart-line.html',
  // CONTRACT: Keep `block w-full` on the host. A bare custom element is
  // display:inline, so as a flex item under `items-start` it shrinks to its own
  // text and the template's `w-full` resolves against that: each line gets a
  // different width and the prices stop sharing a right edge, worst on the
  // widest one ($149.00 juts past its neighbours). See [[angular-component-authoring]]
  host: { class: 'block w-full' },
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
