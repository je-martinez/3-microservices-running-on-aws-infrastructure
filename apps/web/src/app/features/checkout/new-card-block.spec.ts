import { ErrorHandler } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  LucideApple,
  LucideCreditCard,
  LucideInfo,
  LucideLink,
  provideLucideIcons,
} from '@lucide/angular';
import { of, throwError } from 'rxjs';
import type { Stripe, StripeElements } from '@stripe/stripe-js';

import { NewCardBlock } from './new-card-block';
import { PaymentMethodsApi } from '../../core/api/payment-methods-api';
import { StripeLoader } from '../../core/payments/stripe-loader';
import { ApiError } from '../../core/http/api-client';
import { settle } from '../auth/testing';

/** A Payment Element that records mounting without touching a real iframe. */
function fakeElements(): { elements: StripeElements; mounted: string[] } {
  const mounted: string[] = [];
  const element = {
    mount: (target: string | HTMLElement) => {
      mounted.push(typeof target === 'string' ? target : (target.getAttribute('data-testid') ?? ''));
    },
    unmount: () => undefined,
    destroy: () => undefined,
    on: () => element,
  };
  const elements = { create: () => element, getElement: () => element } as unknown as StripeElements;
  return { elements, mounted };
}

interface StripeStub {
  stripe: Stripe;
  mounted: string[];
  confirmSetup: ReturnType<typeof vi.fn>;
}

function fakeStripe(
  result: Awaited<ReturnType<Stripe['confirmSetup']>> = {
    setupIntent: { payment_method: 'pm_new' },
  } as never,
): StripeStub {
  const { elements, mounted } = fakeElements();
  const confirmSetup = vi.fn().mockResolvedValue(result);
  const stripe = { elements: () => elements, confirmSetup } as unknown as Stripe;
  return { stripe, mounted, confirmSetup };
}

describe('NewCardBlock', () => {
  let fixture: ComponentFixture<NewCardBlock>;
  let attach: ReturnType<typeof vi.fn>;
  let createSetupIntent: ReturnType<typeof vi.fn>;
  let handleError: ReturnType<typeof vi.fn>;

  function configure(stub: StripeStub): void {
    attach = vi.fn().mockReturnValue(of({ id: 'pm_new' }));
    createSetupIntent = vi.fn().mockReturnValue(of({ clientSecret: 'seti_1_secret_abc' }));
    handleError = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideLucideIcons(LucideApple, LucideCreditCard, LucideInfo, LucideLink),
        { provide: PaymentMethodsApi, useValue: { attach, createSetupIntent } },
        { provide: StripeLoader, useValue: { load: () => Promise.resolve(stub.stripe) } },
        { provide: ErrorHandler, useValue: { handleError } },
      ],
    });
  }

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  async function render(stub: StripeStub = fakeStripe()): Promise<HTMLElement> {
    configure(stub);
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(NewCardBlock);
    fixture.detectChanges();
    await settle(fixture);
    return fixture.nativeElement as HTMLElement;
  }

  function query(root: HTMLElement, testid: string): HTMLElement | null {
    return root.querySelector(`[data-testid="${testid}"]`);
  }

  it('renders the three method tabs, with Card active', async () => {
    const root = await render();

    expect(query(root, 'tab-card')?.textContent).toContain('Card');
    expect(query(root, 'tab-apple-pay')?.textContent).toContain('Apple Pay');
    expect(query(root, 'tab-link')?.textContent).toContain('Link');
    expect(query(root, 'tab-card')?.className).toContain('border-brand-orange');
  });

  /** The four SField rows live inside Stripe's iframe; this is its mount host. */
  it('mounts the Payment Element into its own container', async () => {
    const stub = fakeStripe();
    const root = await render(stub);

    expect(query(root, 'payment-element')).not.toBeNull();
    expect(stub.mounted).toContain('payment-element');
    expect(createSetupIntent).toHaveBeenCalledTimes(1);
  });

  it('defaults "Save this card for future purchases" to unchecked', async () => {
    const root = await render();
    const checkbox = query(root, 'save-card-checkbox');

    expect(checkbox?.getAttribute('aria-checked')).toBe('false');
  });

  it('emits cancel when the Cancel link is clicked', async () => {
    const root = await render();
    const cancels: number[] = [];
    fixture.componentInstance.cancelled.subscribe(() => cancels.push(1));

    query(root, 'cancel-link')?.click();

    expect(cancels).toEqual([1]);
  });

  /**
   * CONTRACT: Decision 23's real branch. Unchecked means the pm_... is used ONCE
   * on this order and never attached — attaching anyway writes a saved card the
   * buyer declined, which then shows up in every later listing.
   */
  it('attaches the payment method only when "save this card" is checked', async () => {
    const root = await render();

    query(root, 'save-card-button')?.click();
    await settle(fixture);
    expect(attach).not.toHaveBeenCalled();

    query(root, 'save-card-checkbox')?.click();
    fixture.detectChanges();
    query(root, 'save-card-button')?.click();
    await settle(fixture);

    expect(attach).toHaveBeenCalledWith('pm_new');
  });

  it('emits the confirmed payment method id, saved or not', async () => {
    const root = await render();
    const confirmed: { id: string; saved: boolean }[] = [];
    fixture.componentInstance.confirmed.subscribe((event) => confirmed.push(event));

    query(root, 'save-card-button')?.click();
    await settle(fixture);

    expect(confirmed).toEqual([{ id: 'pm_new', saved: false }]);
  });

  /**
   * CONTRACT: A Stripe confirmation failure REACHES ErrorHandler. A component
   * that renders the message and stops deletes the failure from rum_logs, and
   * the declined-card path then looks like it never happened.
   * See [[browser-rum]]
   */
  it('reports a rejected confirmation to the error handler and shows its message', async () => {
    const stub = fakeStripe({
      error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' },
    } as never);
    const root = await render(stub);
    const confirmed: unknown[] = [];
    fixture.componentInstance.confirmed.subscribe((event) => confirmed.push(event));

    query(root, 'save-card-button')?.click();
    await settle(fixture);

    expect(query(root, 'card-error')?.textContent).toContain('Your card was declined.');
    expect(confirmed).toEqual([]);
    expect(handleError).toHaveBeenCalledTimes(1);
  });

  /**
   * CONTRACT: Only message/type reach the handler, never the Stripe error object
   * itself — the emitted allow-list is closed, and a Stripe error carries
   * payment_method details that must not enter rum_logs. See [[browser-rum]]
   */
  it('reports an Error carrying only the message and type, not the Stripe object', async () => {
    const stub = fakeStripe({
      error: {
        type: 'card_error',
        code: 'card_declined',
        message: 'Your card was declined.',
        payment_method: { id: 'pm_secret', card: { last4: '0002' } },
      },
    } as never);
    await render(stub);

    fixture.nativeElement.querySelector('[data-testid="save-card-button"]').click();
    await settle(fixture);

    const reported = handleError.mock.calls[0][0] as Error;
    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toContain('Your card was declined.');
    expect(JSON.stringify(reported)).not.toContain('pm_secret');
  });

  it('reports an ApiError from attach and keeps the buyer informed', async () => {
    const stub = fakeStripe();
    configure(stub);
    attach.mockReturnValue(throwError(() => new ApiError(402, { error: 'card_declined' }, 'HTTP 402')));
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(NewCardBlock);
    fixture.detectChanges();
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;

    query(root, 'save-card-checkbox')?.click();
    fixture.detectChanges();
    query(root, 'save-card-button')?.click();
    await settle(fixture);

    expect(query(root, 'card-error')?.textContent).toBeTruthy();
    expect(handleError).toHaveBeenCalledTimes(1);
  });
});
