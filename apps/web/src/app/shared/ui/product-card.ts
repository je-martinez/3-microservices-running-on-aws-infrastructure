import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LucideCheck, LucideImageOff, LucidePlus } from '@lucide/angular';

import { QtyStepper } from './qty-stepper';
import { type Product, toInt } from '../../core/api/types';
import { CartStore } from '../../core/cart/cart-store';

/**
 * Design: frame `Product Card` (QmNIg), reused in the `Home — Products` grid.
 * `image` is nullable, with a token surface standing in. The Add button morphs
 * into `QtyStepper` once the cart holds the product, so the card drives
 * `CartStore` itself and has no `add` output.
 *
 * CONTRACT: Render `unitPrice.formatted` verbatim — never rebuild a price
 * string from `cents`. The server rounds tax per line, so a client deriving its
 * own display value shows a figure a cent away from what checkout charges.
 * `unitsInStock` is `IntLike`, so `toInt` before comparing: `"0" === 0` is
 * false and a sold-out product renders as in stock. See [[money-representation]]
 */
@Component({
  selector: 'app-product-card',
  imports: [LucideCheck, LucideImageOff, LucidePlus, QtyStepper],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './product-card.html',
})
export class ProductCard {
  readonly product = input.required<Product>();

  private readonly cart = inject(CartStore);

  /**
   * CONTRACT: Read through the store's index, never a local counter. The
   * quantity can change from the cart drawer while this card stays mounted, and
   * the store's optimistic overlay is what makes the stepper track the buyer's
   * finger during a debounce window.
   * See [[2026-09-04-web-gateway-integration-design]]
   */
  protected readonly quantity = computed(() => this.cart.quantityOf()(this.product().id));
  protected readonly inCart = computed(() => this.quantity() > 0);

  protected readonly price = computed(() => this.product().unitPrice.formatted);
  protected readonly stock = computed(() => toInt(this.product().unitsInStock));
  protected readonly outOfStock = computed(() => this.stock() === 0);
  protected readonly category = computed(() => this.product().categories[0]?.toUpperCase());
  protected readonly canIncrement = computed(() => this.quantity() < this.stock());

  /**
   * CONTRACT: Always through CartStore, never CartApi. Two fast clicks on a
   * buyer with no cart yet are the creation race that makes the losing PUT
   * answer 500 (JE-246); the store's queue is what serializes them.
   */
  protected onAdd(): void {
    void this.cart.add(this.product().id);
  }

  /**
   * CONTRACT: `adjustQuantity`, never `setQuantity`. Writing per click makes
   * five taps five sequential PUTs, each a round trip the buyer waits out with
   * a stale total on screen.
   */
  protected onIncrement(): void {
    this.cart.adjustQuantity(this.product().id, this.quantity() + 1);
  }

  protected onDecrement(): void {
    this.cart.adjustQuantity(this.product().id, this.quantity() - 1);
  }

  protected onRemove(): void {
    void this.cart.remove(this.product().id);
  }
}
