import { Component, computed, input, output } from '@angular/core';
import { LucidePlus } from '@lucide/angular';
import { formatCents, type Product, toInt } from '../../fixtures/api-types';

/**
 * Design: frame `Product Card` (QmNIg, 318px wide), reused in the `Home —
 * Products` grid (`eK0x6`/`ffO4d`).
 *
 * `image` is nullable (a token surface stands in when absent) and
 * `unitPriceCents` is `IntLike` — read through `formatCents`/`toInt` rather
 * than doing arithmetic on a value that may arrive as a string. Out-of-stock
 * (`unitsInStock === 0`) disables the Add button instead of hiding it: the
 * design has no separate "sold out" card layout.
 */
@Component({
  selector: 'app-product-card',
  imports: [LucidePlus],
  templateUrl: './product-card.html',
})
export class ProductCard {
  readonly product = input.required<Product>();
  readonly add = output<void>();

  protected readonly price = computed(() => `$${formatCents(this.product().unitPriceCents)}`);
  protected readonly outOfStock = computed(() => toInt(this.product().unitsInStock) === 0);
  protected readonly category = computed(() => this.product().categories[0]?.toUpperCase());
}
