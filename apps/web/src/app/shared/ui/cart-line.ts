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
  template: `
    <div class="flex h-fit w-full flex-row items-start justify-start gap-[14px]">
      @if (product().image; as image) {
        <img
          [src]="image.uri"
          [alt]="product().name"
          class="h-[88px] w-[76px] shrink-0 rounded-lg object-cover"
        />
      } @else {
        <div class="bg-surface-subtle h-[88px] w-[76px] shrink-0 rounded-lg"></div>
      }
      <div class="flex h-[88px] flex-1 flex-col items-start justify-between">
        <div class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-[3px]">
          <div class="text-ink-primary w-full text-[14.5px] leading-[20px] font-semibold">
            {{ product().name }}
          </div>
          @if (variant(); as variantLabel) {
            <div class="text-ink-secondary text-[13px]">{{ variantLabel }}</div>
          }
        </div>
        <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
          <div
            class="border-line-strong flex h-[34px] w-fit shrink-0 flex-row items-center justify-start rounded-lg border"
          >
            <button
              type="button"
              class="flex h-[34px] w-8 shrink-0 flex-row items-center justify-center"
              [disabled]="quantity() <= 1"
              (click)="decrement.emit()"
            >
              <svg lucideMinus class="text-ink-secondary h-3.5 w-3.5"></svg>
            </button>
            <div class="flex h-[34px] w-[30px] shrink-0 flex-row items-center justify-center">
              <span class="text-ink-primary text-sm font-semibold">{{ quantity() }}</span>
            </div>
            <button
              type="button"
              class="flex h-[34px] w-8 shrink-0 flex-row items-center justify-center"
              (click)="increment.emit()"
            >
              <svg lucidePlus class="text-ink-primary h-3.5 w-3.5"></svg>
            </button>
          </div>
          <span class="text-ink-primary text-[14.5px] font-semibold">{{ linePrice() }}</span>
        </div>
      </div>
    </div>
  `,
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
