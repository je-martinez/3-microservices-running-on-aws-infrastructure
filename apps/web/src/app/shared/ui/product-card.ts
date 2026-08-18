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
  template: `
    <article class="flex h-fit w-full flex-col items-start justify-start gap-[14px]">
      @if (product().image; as image) {
        <img
          [src]="image.uri"
          [alt]="product().name"
          class="h-[300px] w-full shrink-0 rounded-md object-cover"
        />
      } @else {
        <!-- The design has no artwork for this state; a token surface stands in. -->
        <div class="bg-surface-subtle h-[300px] w-full shrink-0 rounded-md"></div>
      }
      <div class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-[6px]">
        @if (category(); as categoryLabel) {
          <div class="text-ink-muted text-[11px] font-semibold tracking-[1.6px]">
            {{ categoryLabel }}
          </div>
        }
        <h3 class="text-ink-primary w-full text-[15.5px] leading-[21px] font-semibold">
          {{ product().name }}
        </h3>
      </div>
      <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
        <span class="text-ink-primary text-lg font-bold tracking-[-0.3px]">{{ price() }}</span>
        @if (outOfStock()) {
          <span class="text-danger-red text-xs font-semibold">Out of stock</span>
        } @else {
          <button
            type="button"
            class="bg-brand-navy text-surface-white flex h-[40px] w-fit shrink-0 flex-row items-center justify-start gap-[7px] rounded-lg px-4"
            (click)="add.emit()"
          >
            <svg lucidePlus class="h-4 w-4"></svg>
            <span class="text-sm font-semibold">Add</span>
          </button>
        }
      </div>
    </article>
  `,
})
export class ProductCard {
  readonly product = input.required<Product>();
  readonly add = output<void>();

  protected readonly price = computed(() => `$${formatCents(this.product().unitPriceCents)}`);
  protected readonly outOfStock = computed(() => toInt(this.product().unitsInStock) === 0);
  protected readonly category = computed(() => this.product().categories[0]?.toUpperCase());
}
