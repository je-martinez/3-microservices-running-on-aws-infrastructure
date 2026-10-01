import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import { LucideMinus, LucidePlus, LucideTrash2 } from '@lucide/angular';

import { toInt } from '../../core/api/types';

/** How long the counter takes to roll to a new number. */
const ROLL_MS = 200;
const ROLL_EASING = 'cubic-bezier(.2,.8,.2,1)';

/**
 * Design: `.pen` component `Qty Stepper` (`a7S8KL`), instanced by both
 * `Product Card` (`QmNIg`) and `Cart Line` (`L5XVFs`).
 *
 * CONTRACT: This control holds no cart knowledge. `canIncrement` is RECEIVED,
 * never derived — `cart-line` computes it from the line's `unitsInStock` and
 * `product-card` from the product's, two sources with different semantics that
 * this component must not choose between.
 * See [[2026-09-30-cart-add-quantity-morph-design]]
 */
@Component({
  selector: 'app-qty-stepper',
  imports: [LucideMinus, LucidePlus, LucideTrash2],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './qty-stepper.html',
  host: { class: 'block w-fit' },
})
export class QtyStepper {
  readonly quantity = input.required<number>();
  readonly canIncrement = input(true);
  readonly disabled = input(false);
  /** Names the item in the left key's label when that key removes it. */
  readonly itemName = input('');

  readonly increment = output<void>();
  readonly decrement = output<void>();
  readonly removed = output<void>();

  private readonly counter = viewChild.required<ElementRef<HTMLElement>>('counter');

  /** The outgoing clone of the current roll, so a fast second click clears it. */
  private leaving: HTMLElement | null = null;

  /**
   * CONTRACT: Coerce before comparing. `quantity` reaches here as `IntLike`, so
   * `"1" === 1` is false and `"3" > 1` compares strings — both make the trash
   * icon and the decrement branch pick the wrong side.
   */
  protected readonly count = computed(() => toInt(this.quantity()));
  protected readonly isLast = computed(() => this.count() <= 1);
  protected readonly decreaseLabel = computed(() =>
    this.isLast() ? `Remove ${this.itemName()}`.trim() : 'Decrease quantity',
  );

  constructor() {
    let previous: number | null = null;
    effect(() => {
      const next = this.count();
      const from = previous;
      previous = next;
      if (from === null || from === next) return;
      this.roll(from, next > from ? 1 : -1);
    });
  }

  /**
   * CONTRACT: At quantity 1 the left key emits `removed`, not `decrement`. The
   * server has no per-line DELETE, so a stepper that stops at 1 leaves the
   * buyer no way to take an item out of the cart.
   */
  protected onDecrease(): void {
    if (this.isLast()) this.removed.emit();
    else this.decrement.emit();
  }

  /**
   * WHY: `element.animate()` rather than a CSS transition. The roll needs the
   * outgoing and incoming numbers on screen at once, which in CSS alone means
   * keeping two nodes in the template permanently.
   *
   * CONTRACT: Animate a CLONE out and leave the bound `<span>` in place. The
   * span's text is `{{ count() }}`, so Angular rewrites it to the new value on
   * every change: animating it out and removing it on `finish` detaches the
   * node the template owns, and both numbers render stacked on the same digit.
   * See [[2026-09-30-cart-add-quantity-morph-design]]
   */
  private roll(from: number, direction: 1 | -1): void {
    const host = this.counter().nativeElement;
    const live = host.firstElementChild as HTMLElement | null;
    if (!live || !('animate' in host)) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    this.leaving?.remove();
    const leaving = live.cloneNode(true) as HTMLElement;
    leaving.textContent = String(from);
    leaving.setAttribute('aria-hidden', 'true');
    host.append(leaving);
    this.leaving = leaving;

    const options = { duration: ROLL_MS, easing: ROLL_EASING } as const;
    leaving
      .animate(
        [
          { transform: 'translateY(0)', opacity: 1 },
          { transform: `translateY(${-direction * 100}%)`, opacity: 0 },
        ],
        options,
      )
      .addEventListener('finish', () => {
        leaving.remove();
        if (this.leaving === leaving) this.leaving = null;
      });
    live.animate(
      [
        { transform: `translateY(${direction * 100}%)`, opacity: 0 },
        { transform: 'translateY(0)', opacity: 1 },
      ],
      options,
    );
  }
}
