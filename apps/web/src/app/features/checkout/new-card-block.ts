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
import { StripeLoader } from '../../core/payments/stripe-loader';
import {
  confirmedPaymentMethodId,
  mountPaymentElement,
  stripeErrorToError,
} from '../../core/payments/payment-element-mount';
import { authErrorMessage } from '../auth/auth-errors';

/** What the caller needs to know once a card is tokenized. */
export interface ConfirmedCard {
  id: string;
  /** False when the buyer declined to save it — see Decision 23's branch. */
  saved: boolean;
}


const UNAVAILABLE = 'Card entry is unavailable right now. Please try again later.';

/**
 * Design: `New Card Block` inside `Stripe Payment Element` (`wgkmW` / mobile
 * `V2wb9b`). The four `SField` rows the frame draws are Stripe's own, rendered
 * inside the Payment Element's iframe rather than by this template.
 *
 * CONTRACT: The PAYMENT Element, never the legacy Card Element and never the
 * Payment Element restricted to card-only. Stripe directs new integrations to
 * the Payment Element, and it surfaces every eligible method with no extra code.
 * See [[2026-09-19-stripe-payments-design]]
 */
@Component({
  selector: 'app-new-card-block',
  imports: [LucideCheck, LucideDynamicIcon],
  templateUrl: './new-card-block.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block w-full' },
})
export class NewCardBlock {
  private readonly paymentMethods = inject(PaymentMethodsApi);
  private readonly stripeLoader = inject(StripeLoader);
  private readonly errorHandler = inject(ErrorHandler);

  /**
   * CONTRACT: NOT named `cancel` — that collides with the DOM's own `cancel`
   * event and angular-eslint rejects it (`no-output-native`).
   */
  readonly cancelled = output<void>();
  readonly confirmed = output<ConfirmedCard>();


  /** Decision 23: unchecked by default — saving a card is opt-in. */
  protected readonly saveForFuture = signal(false);
  protected readonly confirming = signal(false);
  protected readonly cardError = signal<string | null>(null);

  private readonly stripe = signal<Stripe | null>(null);
  private readonly elements = signal<StripeElements | null>(null);

  /** True once loading or minting a SetupIntent has failed for good. */
  protected readonly unavailable = signal(false);

  protected readonly canConfirm = computed(
    () => this.elements() !== null && !this.confirming() && !this.unavailable(),
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

  protected toggleSaveForFuture(): void {
    this.saveForFuture.update((value) => !value);
  }

  /**
   * Confirms the SetupIntent, then attaches ONLY if the buyer asked to.
   *
   * CONTRACT: Every failure path reports to ErrorHandler as well as rendering a
   * message. A caught-and-rendered error never reaches `RumErrorHandler`, so a
   * declined card is absent from `rum_logs` while the dashboards stay green.
   * See [[browser-rum]]
   */
  protected async confirm(): Promise<void> {
    const stripe = this.stripe();
    const elements = this.elements();
    if (!stripe || !elements || this.confirming()) return;

    this.confirming.set(true);
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

      const saved = this.saveForFuture();
      if (saved) await firstValueFrom(this.paymentMethods.attach(paymentMethodId));
      this.confirmed.emit({ id: paymentMethodId, saved });
    } catch (error: unknown) {
      this.report(error);
      this.cardError.set(authErrorMessage(error));
    } finally {
      this.confirming.set(false);
    }
  }

  /**
   * CONTRACT: Mint the SetupIntent HERE, when the form opens — not when the
   * selector renders. Every call creates a new SetupIntent in Stripe, so tying
   * it to the list leaves one abandoned intent per page view.
   */
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
