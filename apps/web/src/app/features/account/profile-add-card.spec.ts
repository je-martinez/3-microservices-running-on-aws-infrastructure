import { ErrorHandler } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  LucideApple,
  LucideCheck,
  LucideCreditCard,
  LucideLink,
  provideLucideIcons,
} from '@lucide/angular';
import { of, throwError } from 'rxjs';
import type { Stripe, StripeElements } from '@stripe/stripe-js';

import { ProfileAddCard } from './profile-add-card';
import { PaymentMethodsApi } from '../../core/api/payment-methods-api';
import { StripeLoader } from '../../core/payments/stripe-loader';
import { ApiError } from '../../core/http/api-client';
import { settle } from '../auth/testing';

/** A Stripe stub whose Payment Element mounts without an iframe. */
function fakeStripe(confirmSetup: ReturnType<typeof vi.fn>): Stripe {
  const element = { mount: () => undefined, unmount: () => undefined, on: () => element };
  const elements = { create: () => element, getElement: () => element } as unknown as StripeElements;
  return { elements: () => elements, confirmSetup } as unknown as Stripe;
}

describe('ProfileAddCard', () => {
  let fixture: ComponentFixture<ProfileAddCard>;
  let controller: HttpTestingController;
  let paymentMethods: {
    createSetupIntent: ReturnType<typeof vi.fn>;
    attach: ReturnType<typeof vi.fn>;
    setDefault: ReturnType<typeof vi.fn>;
  };
  let handleError: ReturnType<typeof vi.fn>;
  let load: ReturnType<typeof vi.fn>;
  let confirmSetup: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    confirmSetup = vi.fn().mockResolvedValue({ setupIntent: { payment_method: 'pm_new' } });
    paymentMethods = {
      createSetupIntent: vi.fn().mockReturnValue(of({ clientSecret: 'seti_1_secret_abc' })),
      attach: vi.fn().mockReturnValue(of({ id: 'pm_new' })),
      setDefault: vi.fn().mockReturnValue(of(undefined)),
    };
    handleError = vi.fn();
    load = vi.fn().mockResolvedValue(fakeStripe(confirmSetup));
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideLucideIcons(LucideApple, LucideCheck, LucideCreditCard, LucideLink),
        { provide: PaymentMethodsApi, useValue: paymentMethods },
        { provide: StripeLoader, useValue: { load } },
        { provide: ErrorHandler, useValue: { handleError } },
      ],
    });
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify({ ignoreCancelled: true });
    TestBed.resetTestingModule();
  });

  async function render(): Promise<HTMLElement> {
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(ProfileAddCard);
    fixture.detectChanges();
    await settle(fixture);
    return fixture.nativeElement as HTMLElement;
  }

  function query(root: HTMLElement, testid: string): HTMLElement | null {
    return root.querySelector(`[data-testid="${testid}"]`);
  }

  function submit(root: HTMLElement): void {
    query(root, 'add-card-button-submit')?.click();
  }

  /**
   * CONTRACT: The SetupIntent is minted when this form MOUNTS, not when the
   * card list renders — every call creates a new intent in Stripe, so tying it
   * to the list leaves one abandoned intent per page view.
   */
  it('mounts the Payment Element against a freshly minted client secret', async () => {
    const root = await render();

    expect(load).toHaveBeenCalledTimes(1);
    expect(paymentMethods.createSetupIntent).toHaveBeenCalledTimes(1);
    expect(query(root, 'payment-element')).not.toBeNull();
    expect(query(root, 'card-entry-unavailable')).toBeNull();
  });

  /**
   * CONTRACT: Saving is IMPLICIT on the profile — a card added here is always
   * attached. The checkbox only chooses whether it also becomes the default.
   */
  it('attaches the confirmed card and emits it', async () => {
    const added: string[] = [];
    const root = await render();
    fixture.componentInstance.added.subscribe((id) => added.push(id));

    submit(root);
    await settle(fixture);

    expect(confirmSetup).toHaveBeenCalledTimes(1);
    expect(paymentMethods.attach).toHaveBeenCalledWith('pm_new');
    expect(added).toEqual(['pm_new']);
  });

  /** The design ships the checkbox checked, so the common case needs no click. */
  it('sets the new card as default by default', async () => {
    const root = await render();

    expect(query(root, 'default-card-checkbox')?.getAttribute('aria-checked')).toBe('true');

    submit(root);
    await settle(fixture);

    expect(paymentMethods.setDefault).toHaveBeenCalledWith('pm_new');
  });

  /**
   * CONTRACT: `setDefault` runs only when asked. Calling it unconditionally
   * silently demotes the card the buyer already chose as their default.
   */
  it('skips setDefault when the checkbox is unchecked', async () => {
    const root = await render();

    query(root, 'default-card-checkbox')?.click();
    fixture.detectChanges();
    submit(root);
    await settle(fixture);

    expect(paymentMethods.attach).toHaveBeenCalledWith('pm_new');
    expect(paymentMethods.setDefault).not.toHaveBeenCalled();
  });

  it('emits cancelled from the Cancel link', async () => {
    let cancelled = 0;
    const root = await render();
    fixture.componentInstance.cancelled.subscribe(() => (cancelled += 1));

    query(root, 'cancel-link')?.click();

    expect(cancelled).toBe(1);
  });

  /**
   * CONTRACT: A declined card reaches ErrorHandler as well as the screen. A
   * component that renders the message and stops deletes that failure from
   * rum_logs while the dashboards stay green. See [[browser-rum]]
   */
  it('reports a declined card to ErrorHandler and shows its message', async () => {
    confirmSetup.mockResolvedValue({
      error: { message: 'Your card was declined.', type: 'card_error' },
    });
    const added: string[] = [];
    const root = await render();
    fixture.componentInstance.added.subscribe((id) => added.push(id));

    submit(root);
    await settle(fixture);

    expect(query(root, 'card-error')?.textContent).toContain('Your card was declined.');
    expect(handleError).toHaveBeenCalled();
    expect(paymentMethods.attach).not.toHaveBeenCalled();
    expect(added).toEqual([]);
  });

  /**
   * CONTRACT: The raw StripeError never reaches ErrorHandler — it carries a
   * `payment_method` with card details, and RumErrorHandler stringifies a
   * non-Error value, so passing it through both leaks fields and loses the
   * message. See [[browser-rum]]
   */
  it('reports a real Error carrying only the message and type', async () => {
    confirmSetup.mockResolvedValue({
      error: { message: 'Your card was declined.', type: 'card_error', payment_method: { id: 'pm_x' } },
    });
    const root = await render();

    submit(root);
    await settle(fixture);

    const reported = handleError.mock.calls[0][0];
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toBe('Your card was declined.');
    expect(reported).not.toHaveProperty('payment_method');
  });

  it('reports a failed attach and shows a message', async () => {
    paymentMethods.attach.mockReturnValue(throwError(() => new ApiError(503, null, 'HTTP 503')));
    const added: string[] = [];
    const root = await render();
    fixture.componentInstance.added.subscribe((id) => added.push(id));

    submit(root);
    await settle(fixture);

    expect(query(root, 'card-error')).not.toBeNull();
    expect(handleError).toHaveBeenCalled();
    expect(added).toEqual([]);
  });

  /**
   * CONTRACT: An unconfigured publishable key renders the unavailable state
   * rather than mounting against an empty key, which Stripe rejects with an
   * opaque error.
   */
  it('renders the unavailable state when no publishable key is configured', async () => {
    load.mockResolvedValue(null);
    const root = await render();

    expect(query(root, 'card-entry-unavailable')).not.toBeNull();
    expect(paymentMethods.createSetupIntent).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLButtonElement>('[data-testid="add-card-button-submit"]')?.disabled).toBe(
      true,
    );
  });

  it('reports a failed SetupIntent mint and disables the submit', async () => {
    paymentMethods.createSetupIntent.mockReturnValue(
      throwError(() => new ApiError(503, null, 'HTTP 503')),
    );
    const root = await render();

    expect(query(root, 'card-entry-unavailable')).not.toBeNull();
    expect(handleError).toHaveBeenCalled();
    expect(root.querySelector<HTMLButtonElement>('[data-testid="add-card-button-submit"]')?.disabled).toBe(
      true,
    );
  });
});
