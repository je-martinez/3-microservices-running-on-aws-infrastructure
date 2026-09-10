import { Component, computed, input, output, ChangeDetectionStrategy } from '@angular/core';
import { LucideMinus, LucidePlus, LucideTriangleAlert } from '@lucide/angular';
import { type CartLine as CartLineDto, toInt } from '../../core/api/types';

/** The sentence shown beside a line the server will not sell. */
const UNAVAILABLE_COPY: Record<string, string> = {
  unknown_product: 'No longer sold',
  out_of_stock: 'Out of stock',
  insufficient_stock: 'Not enough left in stock',
};

/**
 * Design: frame `Cart Line` (L5XVFs), reused in `Cart Drawer` (`ET6dr`) and
 * `Checkout — Payment`'s Order Summary (`DOtD2`). The `.pen` has no unavailable
 * variant; the badge below is built from existing tokens.
 *
 * CONTRACT: Never guard a price, name or image on `available` — only the
 * `unknown_product` reason nulls those four fields, so guarding on `available`
 * blanks the price of every fully-priced low-stock line. Each guard tests the
 * field it is about to read. See [[money-representation]]
 */
@Component({
  selector: 'app-cart-line',
  imports: [LucideMinus, LucidePlus, LucideTriangleAlert],
  templateUrl: './cart-line.html',
  // CONTRACT: Keep `block w-full` on the host. A bare custom element is
  // display:inline, so as a flex item under `items-start` it shrinks to its own
  // text and the template's `w-full` resolves against that: each line gets a
  // different width and the prices stop sharing a right edge, worst on the
  // widest one ($149.00 juts past its neighbours). See [[angular-component-authoring]]
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block w-full' },
})
export class CartLine {
  readonly line = input.required<CartLineDto>();
  /** Hides the stepper where the line is a receipt rather than a control. */
  readonly readonlyQuantity = input(false);
  readonly disabled = input(false);

  readonly increment = output<void>();
  readonly decrement = output<void>();
  readonly removed = output<void>();

  protected readonly quantity = computed(() => toInt(this.line().quantity));
  /** Falls back to the id so a delisted product is still identifiable. */
  protected readonly name = computed(() => this.line().name ?? 'This item is no longer available');

  /**
   * CONTRACT: Render the server's `formatted` string verbatim when it exists.
   * Re-deriving it from `cents` shows a figure a cent away from what checkout
   * charges, because the server rounds tax per line. See [[money-representation]]
   */
  protected readonly price = computed(() => this.line().subtotal?.formatted ?? null);

  protected readonly unavailableCopy = computed(() => {
    const reason = this.line().unavailableReason;
    return reason ? (UNAVAILABLE_COPY[reason] ?? 'Unavailable') : null;
  });

  /** Only a stocked line can go up; the server rejects more than it holds. */
  protected readonly canIncrement = computed(
    () => !this.disabled() && this.quantity() < toInt(this.line().unitsInStock),
  );
}
