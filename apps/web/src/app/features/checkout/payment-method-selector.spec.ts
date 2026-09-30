import { ErrorHandler } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  LucideApple,
  LucideCheck,
  LucideCreditCard,
  LucideInfo,
  LucideLink,
  LucidePlus,
  LucideTrash2,
  provideLucideIcons,
} from '@lucide/angular';
import { of, throwError } from 'rxjs';
import type { Stripe, StripeElements } from '@stripe/stripe-js';

import { PaymentMethodSelector } from './payment-method-selector';
import { PaymentMethodsApi } from '../../core/api/payment-methods-api';
import { StripeLoader } from '../../core/payments/stripe-loader';
import { ApiError } from '../../core/http/api-client';
import type { PaymentMethodView } from '../../core/api/types';
import { settle } from '../auth/testing';

function card(overrides: Partial<PaymentMethodView> = {}): PaymentMethodView {
  return {
    id: 'pm_1',
    type: 'card',
    brand: 'visa',
    last4: '4242',
    expMonth: 4,
    expYear: 2028,
    isDefault: false,
    ...overrides,
  };
}

/** A Stripe stub whose Payment Element mounts without an iframe. */
function fakeStripe(): Stripe {
  const element = { mount: () => undefined, unmount: () => undefined, on: () => element };
  const elements = { create: () => element, getElement: () => element } as unknown as StripeElements;
  return {
    elements: () => elements,
    confirmSetup: vi.fn().mockResolvedValue({ setupIntent: { payment_method: 'pm_new' } }),
  } as unknown as Stripe;
}

describe('PaymentMethodSelector', () => {
  let fixture: ComponentFixture<PaymentMethodSelector>;
  let controller: HttpTestingController;
  let paymentMethods: {
    list: ReturnType<typeof vi.fn>;
    createSetupIntent: ReturnType<typeof vi.fn>;
    attach: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    setDefault: ReturnType<typeof vi.fn>;
  };
  let handleError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    paymentMethods = {
      list: vi.fn().mockReturnValue(of([])),
      createSetupIntent: vi.fn().mockReturnValue(of({ clientSecret: 'seti_1_secret_abc' })),
      attach: vi.fn().mockReturnValue(of({ id: 'pm_new' })),
      remove: vi.fn().mockReturnValue(of(undefined)),
      setDefault: vi.fn().mockReturnValue(of(undefined)),
    };
    handleError = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideLucideIcons(
          LucideApple,
          LucideCheck,
          LucideCreditCard,
          LucideInfo,
          LucideLink,
          LucidePlus,
          LucideTrash2,
        ),
        { provide: PaymentMethodsApi, useValue: paymentMethods },
        { provide: StripeLoader, useValue: { load: () => Promise.resolve(fakeStripe()) } },
        { provide: ErrorHandler, useValue: { handleError } },
      ],
    });
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify({ ignoreCancelled: true });
    TestBed.resetTestingModule();
  });

  async function render(cards: PaymentMethodView[]): Promise<HTMLElement> {
    paymentMethods.list.mockReturnValue(of(cards));
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(PaymentMethodSelector);
    fixture.detectChanges();
    await settle(fixture);
    return fixture.nativeElement as HTMLElement;
  }

  function query(root: HTMLElement, testid: string): HTMLElement | null {
    return root.querySelector(`[data-testid="${testid}"]`);
  }

  function rows(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll('app-saved-card-row'));
  }

  it('lists the saved cards it read from the gateway', async () => {
    const root = await render([card(), card({ id: 'pm_2', brand: 'mastercard', last4: '5556' })]);

    expect(paymentMethods.list).toHaveBeenCalledTimes(1);
    expect(rows(root)).toHaveLength(2);
    expect(root.textContent).toContain('Visa ···· 4242');
    expect(root.textContent).toContain('Mastercard ···· 5556');
  });

  /**
   * CONTRACT: The default is preselected, so the common case needs no click.
   * Leaving nothing selected keeps `canPay` false on a buyer who has a card.
   */
  it('preselects the default card and emits its id', async () => {
    const selected: (string | null)[] = [];
    paymentMethods.list.mockReturnValue(
      of([card(), card({ id: 'pm_2', isDefault: true })]),
    );
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(PaymentMethodSelector);
    fixture.componentInstance.selectedPaymentMethodId.subscribe((id) => selected.push(id));
    fixture.detectChanges();
    await settle(fixture);

    expect(selected).toEqual(['pm_2']);
  });

  /** With no default flagged, the first selectable card stands in for one. */
  it('falls back to the first live card when none is flagged default', async () => {
    const selected: (string | null)[] = [];
    paymentMethods.list.mockReturnValue(of([card({ id: 'pm_a' }), card({ id: 'pm_b' })]));
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(PaymentMethodSelector);
    fixture.componentInstance.selectedPaymentMethodId.subscribe((id) => selected.push(id));
    fixture.detectChanges();
    await settle(fixture);

    expect(selected).toEqual(['pm_a']);
  });

  /**
   * CONTRACT: An expired card is never preselected. It renders in place per
   * Decision 24, but selecting it hands the PaymentIntent a card that declines.
   */
  it('skips an expired default when preselecting', async () => {
    const selected: (string | null)[] = [];
    paymentMethods.list.mockReturnValue(
      of([
        card({ id: 'pm_old', isDefault: true, expMonth: 1, expYear: 2020 }),
        card({ id: 'pm_live' }),
      ]),
    );
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(PaymentMethodSelector);
    fixture.componentInstance.selectedPaymentMethodId.subscribe((id) => selected.push(id));
    fixture.detectChanges();
    await settle(fixture);

    expect(selected).toEqual(['pm_live']);
  });

  it('renders an expired card in place, with the danger expiry text', async () => {
    const root = await render([card({ expMonth: 1, expYear: 2020 })]);

    expect(rows(root)).toHaveLength(1);
    const expiry = root.querySelector('[data-testid="card-expiry"]');
    expect(expiry?.textContent).toContain('Expired 01 / 2020');
    expect(expiry?.className).toContain('text-danger-red');
  });

  /**
   * Decision 24's three states in ONE list, which is how the buyer meets them.
   * Each row is asserted by position, so a state leaking across rows — an
   * expired row dimming the live one, a default badge on every card — fails
   * here where a single-row render cannot see it.
   */
  it('renders the selected-default, unselected and expired states side by side', async () => {
    const root = await render([
      card({ id: 'pm_default', isDefault: true }),
      card({ id: 'pm_other', last4: '5556' }),
      card({ id: 'pm_expired', last4: '0005', expMonth: 1, expYear: 2020 }),
    ]);

    const [selectedRow, plainRow, expiredRow] = rows(root).map((host) => ({
      row: host.querySelector('[data-testid="saved-card-row"]'),
      bubble: host.querySelector('[data-testid="brand-bubble"]'),
      expiry: host.querySelector('[data-testid="card-expiry"]'),
      badge: host.querySelector('[data-testid="default-badge"]'),
      setDefault: host.querySelector('[data-testid="set-default-link"]'),
      radio: host.querySelector('[data-testid="radio"]'),
    }));

    // 1. Selected + default: subtle fill, navy stroke, badge, no set-default link.
    expect(selectedRow.row?.className).toContain('bg-surface-subtle');
    expect(selectedRow.row?.className).toContain('border-brand-navy');
    expect(selectedRow.badge).not.toBeNull();
    expect(selectedRow.setDefault).toBeNull();

    // 2. Unselected, not default: line stroke, no badge, a set-default link.
    expect(plainRow.row?.className).toContain('border-line');
    expect(plainRow.row?.className).not.toContain('border-brand-navy');
    expect(plainRow.badge).toBeNull();
    expect(plainRow.setDefault).not.toBeNull();

    // 3. Expired: dimmed bubble, danger expiry, an inert radio, and NO
    // set-default link — an expired card cannot become the default either.
    expect(expiredRow.bubble?.className).toContain('bg-surface-subtle');
    expect(expiredRow.expiry?.className).toContain('text-danger-red');
    expect(expiredRow.expiry?.className).toContain('font-semibold');
    expect(expiredRow.radio?.getAttribute('aria-disabled')).toBe('true');
    expect(expiredRow.setDefault).toBeNull();
  });

  /**
   * CONTRACT: Clicking an expired row's radio in the LIVE list emits nothing and
   * leaves the standing selection alone. The row spec proves the component emits
   * nothing; this proves the selector does not then reassign `selectedId` to it,
   * which would hand `pay()` a card the PaymentIntent declines.
   * See [[2026-09-19-stripe-payments-design]]
   */
  it('keeps the live selection when an expired row is clicked', async () => {
    const selected: (string | null)[] = [];
    paymentMethods.list.mockReturnValue(
      of([
        card({ id: 'pm_live', isDefault: true }),
        card({ id: 'pm_expired', expMonth: 1, expYear: 2020 }),
      ]),
    );
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(PaymentMethodSelector);
    fixture.componentInstance.selectedPaymentMethodId.subscribe((id) => selected.push(id));
    fixture.detectChanges();
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;

    const expiredRadio = rows(root)[1].querySelector<HTMLElement>('[data-testid="radio"]');
    expect(expiredRadio, 'the expired row rendered no radio to click').not.toBeNull();
    expiredRadio?.click();
    fixture.detectChanges();

    expect(
      selected,
      `clicking the expired row changed the emitted selection to ${JSON.stringify(selected)} — ` +
        'only the preselected pm_live may appear',
    ).toEqual(['pm_live']);
    // And the live row still carries the selection visually.
    expect(rows(root)[0].querySelector('[data-testid="saved-card-row"]')?.className).toContain(
      'border-brand-navy',
    );
  });

  /** Zero cards means the add-card form is the whole surface. */
  it('shows the new-card block directly when the buyer has no cards', async () => {
    const root = await render([]);

    expect(query(root, 'new-card-block')).not.toBeNull();
    expect(query(root, 'add-card-button')).toBeNull();
    expect(rows(root)).toHaveLength(0);
  });

  it('collapses to the list on Cancel and back on Add card', async () => {
    const root = await render([card()]);

    expect(query(root, 'new-card-block')).toBeNull();

    root.querySelector<HTMLElement>('[data-testid="add-card-button"] button')?.click();
    fixture.detectChanges();
    await settle(fixture);
    expect(query(root, 'new-card-block')).not.toBeNull();
    expect(rows(root)).toHaveLength(0);

    query(root, 'cancel-link')?.click();
    fixture.detectChanges();
    await settle(fixture);
    expect(query(root, 'new-card-block')).toBeNull();
    expect(rows(root)).toHaveLength(1);
  });

  it('emits the clicked card and moves the selection to it', async () => {
    const selected: (string | null)[] = [];
    paymentMethods.list.mockReturnValue(of([card({ isDefault: true }), card({ id: 'pm_2' })]));
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(PaymentMethodSelector);
    fixture.componentInstance.selectedPaymentMethodId.subscribe((id) => selected.push(id));
    fixture.detectChanges();
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;

    Array.from(root.querySelectorAll<HTMLElement>('[data-testid="radio"]'))[1].click();
    fixture.detectChanges();

    expect(selected).toEqual(['pm_1', 'pm_2']);
  });

  /**
   * A card saved from the inline form becomes a selected saved card, so the
   * list is re-read rather than patched locally — Users assigns `isDefault`.
   */
  it('re-reads the list and selects a card saved from the inline form', async () => {
    const selected: (string | null)[] = [];
    paymentMethods.list.mockReturnValueOnce(of([])).mockReturnValue(
      of([card({ id: 'pm_new', isDefault: true })]),
    );
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(PaymentMethodSelector);
    fixture.componentInstance.selectedPaymentMethodId.subscribe((id) => selected.push(id));
    fixture.detectChanges();
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;

    query(root, 'save-card-checkbox')?.click();
    fixture.detectChanges();
    query(root, 'save-card-button')?.click();
    await settle(fixture);

    expect(paymentMethods.list).toHaveBeenCalledTimes(2);
    expect(selected).toContain('pm_new');
  });

  /**
   * CONTRACT: An UNSAVED card is emitted for one-time use and NOT added to the
   * list — attaching it, or re-reading as if it were saved, contradicts the
   * buyer leaving "Save this card" unchecked. See [[2026-09-19-stripe-payments-design]]
   */
  it('emits a one-time card without re-reading the list', async () => {
    const selected: (string | null)[] = [];
    await render([]);
    fixture.componentInstance.selectedPaymentMethodId.subscribe((id) => selected.push(id));
    const root = fixture.nativeElement as HTMLElement;

    query(root, 'save-card-button')?.click();
    await settle(fixture);

    expect(paymentMethods.attach).not.toHaveBeenCalled();
    expect(paymentMethods.list).toHaveBeenCalledTimes(1);
    expect(selected).toEqual(['pm_new']);
  });

  it('sets a default and re-reads the list', async () => {
    const root = await render([card({ isDefault: true }), card({ id: 'pm_2' })]);

    Array.from(root.querySelectorAll<HTMLElement>('[data-testid="set-default-link"]'))[0].click();
    await settle(fixture);

    expect(paymentMethods.setDefault).toHaveBeenCalledWith('pm_2');
    expect(paymentMethods.list).toHaveBeenCalledTimes(2);
  });

  it('removes a card and re-reads the list', async () => {
    const root = await render([card()]);

    query(root, 'remove-button')?.click();
    await settle(fixture);

    expect(paymentMethods.remove).toHaveBeenCalledWith('pm_1');
    expect(paymentMethods.list).toHaveBeenCalledTimes(2);
  });

  /**
   * CONTRACT: A removed card that was the selection emits null, so `canPay`
   * goes false. Leaving the stale id selected charges a detached payment method
   * and answers 402.
   */
  it('clears the selection when the selected card is removed', async () => {
    const selected: (string | null)[] = [];
    paymentMethods.list.mockReturnValueOnce(of([card({ isDefault: true })])).mockReturnValue(of([]));
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(PaymentMethodSelector);
    fixture.componentInstance.selectedPaymentMethodId.subscribe((id) => selected.push(id));
    fixture.detectChanges();
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;

    query(root, 'remove-button')?.click();
    await settle(fixture);

    expect(selected).toEqual(['pm_1', null]);
  });

  /**
   * CONTRACT: A failed list read reaches ErrorHandler as well as the screen. A
   * component that renders the message and stops deletes the failure from
   * rum_logs. See [[browser-rum]]
   */
  it('reports a failed list read and shows a message', async () => {
    paymentMethods.list.mockReturnValue(throwError(() => new ApiError(503, null, 'HTTP 503')));
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(PaymentMethodSelector);
    fixture.detectChanges();
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;

    expect(query(root, 'cards-error')).not.toBeNull();
    expect(handleError).toHaveBeenCalled();
  });
});
