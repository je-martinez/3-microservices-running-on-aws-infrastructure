import {
  ChangeDetectionStrategy,
  Component,
  ErrorHandler,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { PaymentMethodsApi } from '../../core/api/payment-methods-api';
import type { PaymentMethodView } from '../../core/api/types';
import { isCardExpired } from '../../shared/ui/card-validation';
import { SavedCardRow } from '../../shared/ui/saved-card-row';
import { ButtonGhost } from '../../shared/ui/button-ghost';
import { authErrorMessage } from '../auth/auth-errors';
import { NewCardBlock, type ConfirmedCard } from './new-card-block';

/** A card with its expiry already resolved, so the template computes nothing. */
interface CardEntry {
  card: PaymentMethodView;
  expired: boolean;
}

/**
 * Design: `Stripe Payment Element` inside `Checkout — Payment (add card)`
 * (`wgkmW` / mobile `V2wb9b`) — the `Saved Cards List` plus Decision 23's
 * inline `New Card Block`.
 *
 * CONTRACT: Expiry is computed HERE, once, and passed down — the row takes it as
 * an input. Two surfaces each calling `new Date()` drift at a month boundary and
 * show the same card expired in one list and live in the other.
 * See [[2026-09-19-stripe-payments-design]]
 */
@Component({
  selector: 'app-payment-method-selector',
  imports: [ButtonGhost, NewCardBlock, SavedCardRow],
  templateUrl: './payment-method-selector.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block w-full' },
})
export class PaymentMethodSelector {
  private readonly paymentMethods = inject(PaymentMethodsApi);
  private readonly errorHandler = inject(ErrorHandler);

  /**
   * The card `pay()` charges, or null when there is none. Emitted on every
   * change, including back to null — a selection left stale after the card is
   * removed charges a detached payment method and answers 402.
   */
  readonly selectedPaymentMethodId = output<string | null>();

  protected readonly loading = signal(true);
  protected readonly cardsError = signal<string | null>(null);
  protected readonly selectedId = signal<string | null>(null);

  private readonly cards = signal<readonly PaymentMethodView[]>([]);
  /** True while the buyer chose "Add card" over an existing list. */
  private readonly addingCard = signal(false);

  protected readonly entries = computed<CardEntry[]>(() =>
    this.cards().map((card) => ({
      card,
      expired: isCardExpired(card.expMonth, card.expYear),
    })),
  );

  /** Drives the new-card block's locked "save" checkbox: a first card is always kept. */
  protected readonly noSavedCards = computed(() => this.cards().length === 0);

  /** With no card on file the form IS the surface — there is nothing to pick. */
  protected readonly showNewCardBlock = computed(
    () => this.addingCard() || (!this.loading() && this.noSavedCards()),
  );

  constructor() {
    void this.reload();
  }

  protected openNewCard(): void {
    this.addingCard.set(true);
  }

  protected closeNewCard(): void {
    this.addingCard.set(false);
  }

  protected onSelect(id: string): void {
    this.setSelected(id);
  }

  protected async onSetDefault(id: string): Promise<void> {
    await this.mutate(() => firstValueFrom(this.paymentMethods.setDefault(id)));
  }

  protected async onRemove(id: string): Promise<void> {
    await this.mutate(() => firstValueFrom(this.paymentMethods.remove(id)));
  }

  /**
   * CONTRACT: A SAVED card re-reads the list and selects it, which swaps the
   * form for the saved-cards list; an unsaved one does not re-read. Users
   * assigns `isDefault` on attach, so a locally patched list can render a
   * default badge the server did not grant. An unsaved card exists only when
   * the buyer already has cards — a first card is always saved.
   * See [[2026-09-19-stripe-payments-design]]
   */
  protected async onCardConfirmed(confirmed: ConfirmedCard): Promise<void> {
    this.addingCard.set(false);
    if (confirmed.saved) {
      await this.reload({ select: confirmed.id });
      return;
    }
    this.setSelected(confirmed.id);
  }

  /** Re-reads after a write, so `isDefault` comes from the server, not a guess. */
  private async mutate(write: () => Promise<unknown>): Promise<void> {
    this.cardsError.set(null);
    try {
      await write();
    } catch (error: unknown) {
      this.report(error);
      this.cardsError.set(authErrorMessage(error));
      return;
    }
    await this.reload();
  }

  /**
   * CONTRACT: Report to ErrorHandler as well as rendering the message. A
   * component that catches its own ApiError and only renders it deletes that
   * failure from `rum_logs` while the dashboards stay green. See [[browser-rum]]
   */
  private async reload(options: { select?: string } = {}): Promise<void> {
    this.loading.set(true);
    this.cardsError.set(null);
    try {
      const cards = await firstValueFrom(this.paymentMethods.list());
      this.cards.set(cards);
      this.setSelected(options.select ?? this.resolveSelection(cards));
    } catch (error: unknown) {
      this.report(error);
      this.cardsError.set(authErrorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Keeps the buyer's own pick across a reload; otherwise the default card, and
   * failing that the first live one.
   *
   * CONTRACT: An EXPIRED card is never chosen here, even flagged default — it
   * renders in place per Decision 24, but the PaymentIntent declines it.
   * See [[2026-09-19-stripe-payments-design]]
   */
  private resolveSelection(cards: readonly PaymentMethodView[]): string | null {
    const live = cards.filter((card) => !isCardExpired(card.expMonth, card.expYear));
    const current = this.selectedId();
    if (current !== null && live.some((card) => card.id === current)) return current;
    return (live.find((card) => card.isDefault) ?? live[0])?.id ?? null;
  }

  /** Emits only on a real change, so a reload does not re-announce the same id. */
  private setSelected(id: string | null): void {
    if (this.selectedId() === id) return;
    this.selectedId.set(id);
    this.selectedPaymentMethodId.emit(id);
  }

  private report(error: unknown): void {
    this.errorHandler.handleError(error);
  }
}
