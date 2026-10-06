import {
  ChangeDetectionStrategy,
  Component,
  ErrorHandler,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { LucideCheck, LucideDynamicIcon } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import type { Stripe, StripeElements } from '@stripe/stripe-js';

import { PaymentMethodsApi } from '../../core/api/payment-methods-api';
import {
  confirmCardSetup,
  openCardEntry,
} from '../../core/payments/payment-element-mount';
import { StripeLoader } from '../../core/payments/stripe-loader';
import { authErrorMessage } from '../auth/auth-errors';

/**
 * Design: `New Card Block` inside `Profile — Add Card` (`wnUi1` / mobile
 * `WQAq0`). The four `SField` rows the frame draws are Stripe's own, rendered
 * inside the Payment Element's iframe rather than by this template.
 *
 * CONTRACT: Saving is IMPLICIT here, unlike the checkout's block — a card added
 * from the profile is ALWAYS attached, and the checkbox chooses only whether it
 * also becomes the default. Reusing the checkout's opt-in "Save this card"
 * semantics leaves the buyer on a card-management screen whose Add button adds
 * nothing. See [[2026-09-19-stripe-payments-design]]
 */
@Component({
  selector: 'app-profile-add-card',
  imports: [LucideCheck, LucideDynamicIcon],
  templateUrl: './profile-add-card.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block w-full' },
})
export class ProfileAddCard {
  private readonly paymentMethods = inject(PaymentMethodsApi);
  private readonly stripeLoader = inject(StripeLoader);
  private readonly errorHandler = inject(ErrorHandler);

  /**
   * CONTRACT: NOT named `cancel` — that collides with the DOM's own `cancel`
   * event and angular-eslint rejects it (`no-output-native`).
   */
  readonly cancelled = output<void>();
  /** The attached card's id, so the owner re-reads its list. */
  readonly added = output<string>();

  /**
   * CONTRACT: True when the buyer has NO saved card — the checkbox then renders
   * checked and locked, since Users makes a customer's first card the default
   * inside the attach itself. Unlocked there, unchecking it promises a
   * non-default card the server never produces.
   */
  readonly defaultRequired = input(false);

  /** Checked in the design frame: a card added deliberately is usually the one to use. */
  protected readonly setAsDefault = signal(true);
  protected readonly willBeDefault = computed(
    () => this.defaultRequired() || this.setAsDefault(),
  );
  protected readonly submitting = signal(false);
  protected readonly cardError = signal<string | null>(null);

  private readonly stripe = signal<Stripe | null>(null);
  private readonly elements = signal<StripeElements | null>(null);

  /** True once loading or minting a SetupIntent has failed for good. */
  protected readonly unavailable = signal(false);

  protected readonly canSubmit = computed(
    () => this.elements() !== null && !this.submitting() && !this.unavailable(),
  );

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('paymentElement');

  constructor() {
    // WHY: An effect rather than the constructor body — the mount target is a
    // viewChild, which is undefined until the first render completes.
    effect(() => {
      const target = this.host().nativeElement;
      if (this.elements() !== null) return;
      void this.mount(target);
    });
  }

  protected toggleSetAsDefault(): void {
    if (this.defaultRequired()) return;
    this.setAsDefault.update((value) => !value);
  }

  /**
   * Confirms the SetupIntent, attaches the card, then promotes it if asked.
   *
   * CONTRACT: `setDefault` runs only when the checkbox is checked AND the card
   * is not the first. Calling it on every add silently demotes the card the
   * buyer already chose as default; a first card is the default on attach.
   *
   * CONTRACT: Every failure path reports to ErrorHandler as well as rendering a
   * message. A caught-and-rendered error never reaches `RumErrorHandler`, so a
   * declined card is absent from `rum_logs` while the dashboards stay green.
   * See [[browser-rum]]
   */
  protected async submit(): Promise<void> {
    const stripe = this.stripe();
    const elements = this.elements();
    if (!stripe || !elements || this.submitting()) return;

    this.submitting.set(true);
    this.cardError.set(null);
    try {
      const setup = await confirmCardSetup(stripe, elements);
      if (!setup.ok) {
        this.report(setup.report);
        this.cardError.set(setup.message);
        return;
      }
      const paymentMethodId = setup.paymentMethodId;

      await firstValueFrom(this.paymentMethods.attach(paymentMethodId));
      if (!this.defaultRequired() && this.setAsDefault()) {
        await firstValueFrom(this.paymentMethods.setDefault(paymentMethodId));
      }
      this.added.emit(paymentMethodId);
    } catch (error: unknown) {
      this.report(error);
      this.cardError.set(authErrorMessage(error));
    } finally {
      this.submitting.set(false);
    }
  }

  private async mount(target: HTMLElement): Promise<void> {
    await openCardEntry(
      () => this.stripeLoader.load(),
      async () => (await firstValueFrom(this.paymentMethods.createSetupIntent())).clientSecret,
      target,
      {
        setStripe: (stripe) => this.stripe.set(stripe),
        setElements: (elements) => this.elements.set(elements),
        setUnavailable: () => this.unavailable.set(true),
        setError: (message) => this.cardError.set(message),
        report: (error) => this.report(error),
      },
      authErrorMessage,
    );
  }

  private report(error: unknown): void {
    this.errorHandler.handleError(error);
  }
}
