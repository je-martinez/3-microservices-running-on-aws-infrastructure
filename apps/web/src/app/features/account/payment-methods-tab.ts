import {
  ChangeDetectionStrategy,
  Component,
  ErrorHandler,
  computed,
  inject,
  signal,
} from '@angular/core';
import { LucideLock } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';

import { PaymentMethodsApi } from '../../core/api/payment-methods-api';
import type { PaymentMethodView } from '../../core/api/types';
import { isCardExpired } from '../../shared/ui/card-validation';
import { ButtonGhost } from '../../shared/ui/button-ghost';
import { SavedCardRow } from '../../shared/ui/saved-card-row';
import { authErrorMessage } from '../auth/auth-errors';
import { ProfileAddCard } from './profile-add-card';

type TabId = 'delivery-address' | 'payment-methods';

/** A card with its expiry already resolved, so the template computes nothing. */
interface CardEntry {
  card: PaymentMethodView;
  expired: boolean;
}

/**
 * Design: `Tabs` plus `Section SAVED CARDS` inside `Profile — Payment Methods`
 * (`VcB4y`, 1440 / `W6IFps`, 390). The delivery-address panel is PROJECTED, so
 * the profile keeps ownership of its address form and this component owns only
 * which of the two panels shows.
 *
 * CONTRACT: Expiry is computed HERE, once, and passed down — the row takes it as
 * an input. Two surfaces each calling `new Date()` drift at a month boundary and
 * show the same card expired in one list and live in the other.
 * See [[2026-09-19-stripe-payments-design]]
 */
@Component({
  selector: 'app-payment-methods-tab',
  imports: [ButtonGhost, LucideLock, ProfileAddCard, SavedCardRow],
  templateUrl: './payment-methods-tab.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
})
export class PaymentMethodsTab {
  private readonly paymentMethods = inject(PaymentMethodsApi);
  private readonly errorHandler = inject(ErrorHandler);

  protected readonly active = signal<TabId>('delivery-address');
  protected readonly loading = signal(true);
  protected readonly cardsError = signal<string | null>(null);

  private readonly cards = signal<readonly PaymentMethodView[]>([]);
  /** True while the buyer chose "Add a card" over an existing list. */
  private readonly addingCard = signal(false);

  protected readonly entries = computed<CardEntry[]>(() =>
    this.cards().map((card) => ({
      card,
      expired: isCardExpired(card.expMonth, card.expYear),
    })),
  );

  protected readonly countLabel = computed(() => {
    const total = this.cards().length;
    return `${total} ${total === 1 ? 'card' : 'cards'}`;
  });

  /** With no card on file the form IS the surface — there is nothing to manage. */
  protected readonly showAddCard = computed(
    () => this.addingCard() || (!this.loading() && this.cards().length === 0),
  );

  constructor() {
    // CONTRACT: Read the list ON MOUNT, not when the tab opens. Deferring it
    // makes the count and the first row appear a request later than the section
    // they sit in, which reads as an empty wallet.
    void this.reload();
  }

  protected select(tab: TabId): void {
    this.active.set(tab);
  }

  protected openAddCard(): void {
    this.addingCard.set(true);
  }

  protected closeAddCard(): void {
    this.addingCard.set(false);
  }

  protected async onSetDefault(id: string): Promise<void> {
    await this.mutate(() => firstValueFrom(this.paymentMethods.setDefault(id)));
  }

  protected async onRemove(id: string): Promise<void> {
    await this.mutate(() => firstValueFrom(this.paymentMethods.remove(id)));
  }

  /**
   * CONTRACT: RE-READ the list after an add, never append the new card locally
   * — Users assigns `isDefault` on attach, so a patched list can render a
   * Default badge the server did not grant.
   */
  protected async onCardAdded(): Promise<void> {
    this.addingCard.set(false);
    await this.reload();
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
  private async reload(): Promise<void> {
    this.loading.set(true);
    this.cardsError.set(null);
    try {
      this.cards.set(await firstValueFrom(this.paymentMethods.list()));
    } catch (error: unknown) {
      this.report(error);
      this.cardsError.set(authErrorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  private report(error: unknown): void {
    this.errorHandler.handleError(error);
  }
}
