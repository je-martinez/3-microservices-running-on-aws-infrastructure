import {
  ChangeDetectionStrategy,
  Component,
  ErrorHandler,
  computed,
  effect,
  inject,
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
  confirmedPaymentMethodId,
  mountPaymentElement,
  stripeErrorToError,
} from '../../core/payments/payment-element-mount';
import { StripeLoader } from '../../core/payments/stripe-loader';
import { authErrorMessage } from '../auth/auth-errors';


const UNAVAILABLE = 'Card entry is unavailable right now. Please try again later.';

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


  /** Checked in the design frame: a card added deliberately is usually the one to use. */
  protected readonly setAsDefault = signal(true);
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
    this.setAsDefault.update((value) => !value);
  }

  /**
   * Confirms the SetupIntent, attaches the card, then promotes it if asked.
   *
   * CONTRACT: `setDefault` runs only when the checkbox is checked. Calling it on
   * every add silently demotes the card the buyer already chose as default.
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
      const result = await stripe.confirmSetup({ elements, redirect: 'if_required' });
      if ('error' in result && result.error) {
        this.report(stripeErrorToError(result.error));
        this.cardError.set(result.error.message ?? UNAVAILABLE);
        return;
      }

      const paymentMethodId = confirmedPaymentMethodId(result);
      if (paymentMethodId === null) {
        this.report(new Error('Stripe confirmed a SetupIntent with no payment method'));
        this.cardError.set(UNAVAILABLE);
        return;
      }

      await firstValueFrom(this.paymentMethods.attach(paymentMethodId));
      if (this.setAsDefault()) {
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
    try {
      const mounted = await mountPaymentElement(
        () => this.stripeLoader.load(),
        async () => (await firstValueFrom(this.paymentMethods.createSetupIntent())).clientSecret,
        target,
      );
      if (!mounted.ok) {
        this.unavailable.set(true);
        return;
      }
      this.stripe.set(mounted.stripe);
      this.elements.set(mounted.elements);
    } catch (error: unknown) {
      this.report(error);
      this.unavailable.set(true);
      this.cardError.set(authErrorMessage(error));
    }
  }

  private report(error: unknown): void {
    this.errorHandler.handleError(error);
  }
}
