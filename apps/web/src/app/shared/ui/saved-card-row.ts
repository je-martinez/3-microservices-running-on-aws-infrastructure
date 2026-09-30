import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { LucideCreditCard, LucideTrash2 } from '@lucide/angular';

import type { PaymentMethodView } from '../../core/api/types';
import { cardBrandLabel } from './card-validation';

/**
 * Design: frame `Saved Card Row` (`vPwZ1`), rendered in the checkout's
 * `Saved Cards List` (`wgkmW`) and the profile's `Cards List` (`VcB4y`). One
 * component for both: the three states of Decision 24 apply in each place.
 *
 * CONTRACT: `expired` arrives as an INPUT, computed by the owner from
 * `isCardExpired` — this row never calls `new Date()` itself. Two surfaces each
 * deriving their own expiry drifts at a month boundary, showing the same card
 * expired in one list and live in the other.
 * See [[2026-09-19-stripe-payments-design]]
 */
@Component({
  selector: 'app-saved-card-row',
  imports: [LucideCreditCard, LucideTrash2],
  templateUrl: './saved-card-row.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // CONTRACT: Keep `block w-full` on the host. A custom element is display:inline,
  // so as a flex item the row shrinks to its own text and the template's `w-full`
  // resolves against that box — each card gets a different width and the remove
  // buttons stop sharing a right edge. See [[angular-component-authoring]]
  host: { class: 'block w-full' },
})
export class SavedCardRow {
  readonly card = input.required<PaymentMethodView>();
  readonly selected = input(false);
  /** False on the profile, where a row is managed rather than chosen. */
  readonly selectable = input(true);
  readonly expired = input(false);

  /**
   * CONTRACT: NOT named `select` — that collides with the DOM's own `select`
   * event and angular-eslint rejects it (`no-output-native`); a parent binding
   * `(select)` would also fire on the browser's event, not only on this one.
   */
  readonly cardSelected = output<string>();
  readonly setDefault = output<string>();
  readonly remove = output<string>();

  protected readonly brandLabel = computed(() => cardBrandLabel(this.card().brand));

  /** "04 / 2028"; the month is zero-padded, the year is the stored four digits. */
  protected readonly expiryLabel = computed(() => {
    const { expMonth, expYear } = this.card();
    if (expMonth === null || expYear === null) return '—';
    return `${String(expMonth).padStart(2, '0')} / ${String(expYear)}`;
  });

  /**
   * The selected row and the expired row share `bg-surface-subtle`; every other
   * row is transparent in the checkout list and white as a standalone frame.
   */
  protected readonly fill = computed<'subtle' | 'white'>(() =>
    this.selected() || this.expired() ? 'subtle' : 'white',
  );

  /**
   * CONTRACT: An expired row emits NOTHING. Dimming it while still emitting lets
   * the buyer pick a card the PaymentIntent then declines, after the order
   * summary already showed it as the payment method.
   */
  protected onSelect(): void {
    if (this.expired()) return;
    this.cardSelected.emit(this.card().id);
  }
}
