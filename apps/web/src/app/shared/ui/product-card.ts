import { Component, computed, input, output, ChangeDetectionStrategy } from '@angular/core';
import { LucideImageOff, LucidePlus } from '@lucide/angular';
import { type Product, toInt } from '../../core/api/types';

/**
 * Design: frame `Product Card` (QmNIg), reused in the `Home — Products` grid.
 * `image` is nullable, with a token surface standing in. Out-of-stock disables
 * the Add button rather than hiding it — the design has no "sold out" layout.
 *
 * CONTRACT: Render `unitPrice.formatted` verbatim — do NOT rebuild a price
 * string from `cents`. The server rounds tax per line, so a client that derives
 * its own display value shows a figure a cent away from what checkout charges.
 * `unitsInStock` stays `IntLike` and needs `toInt`: comparing a string "0" with
 * `=== 0` is false, so a sold-out product would render as in stock.
 * See [[money-representation]]
 */
@Component({
  selector: 'app-product-card',
  imports: [LucideImageOff, LucidePlus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './product-card.html',
})
export class ProductCard {
  readonly product = input.required<Product>();
  readonly add = output<void>();

  protected readonly price = computed(() => this.product().unitPrice.formatted);
  protected readonly outOfStock = computed(() => toInt(this.product().unitsInStock) === 0);
  protected readonly category = computed(() => this.product().categories[0]?.toUpperCase());
}
