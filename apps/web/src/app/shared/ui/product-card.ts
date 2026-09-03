import { Component, computed, input, output } from '@angular/core';
import { LucideImageOff, LucidePlus } from '@lucide/angular';
import { formatCents, type Product, toInt } from '../../fixtures/api-types';

/**
 * Design: frame `Product Card` (QmNIg), reused in the `Home — Products` grid.
 * `image` is nullable, with a token surface standing in. Out-of-stock disables
 * the Add button rather than hiding it — the design has no "sold out" layout.
 *
 * CONTRACT: `unitPriceCents` is `IntLike` — go through `formatCents`/`toInt`,
 * since arithmetic on a value that arrives as a string concatenates instead.
 * See [[money-as-integer-cents]]
 */
@Component({
  selector: 'app-product-card',
  imports: [LucideImageOff, LucidePlus],
  templateUrl: './product-card.html',
})
export class ProductCard {
  readonly product = input.required<Product>();
  readonly add = output<void>();

  protected readonly price = computed(() => `$${formatCents(this.product().unitPriceCents)}`);
  protected readonly outOfStock = computed(() => toInt(this.product().unitsInStock) === 0);
  protected readonly category = computed(() => this.product().categories[0]?.toUpperCase());
}
