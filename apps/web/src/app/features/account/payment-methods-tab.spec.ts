import { ErrorHandler } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import {
  LucideApple,
  LucideCheck,
  LucideCreditCard,
  LucideInfo,
  LucideLink,
  LucideLock,
  LucidePlus,
  LucideTrash2,
  provideLucideIcons,
} from '@lucide/angular';
import { of, throwError } from 'rxjs';
import type { Stripe, StripeElements } from '@stripe/stripe-js';

import { PaymentMethodsTab } from './payment-methods-tab';
import { ProfileAddCard } from './profile-add-card';
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

describe('PaymentMethodsTab', () => {
  let fixture: ComponentFixture<PaymentMethodsTab>;
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
          LucideLock,
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
    fixture = TestBed.createComponent(PaymentMethodsTab);
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

  function addCardForm(): ProfileAddCard | null {
    return fixture.debugElement.query(By.directive(ProfileAddCard))?.componentInstance ?? null;
  }

  async function openPaymentMethods(root: HTMLElement): Promise<void> {
    query(root, 'tab-payment-methods')?.click();
    fixture.detectChanges();
    await settle(fixture);
  }

  it('defaults to the delivery-address tab active, payment-methods inactive', async () => {
    const root = await render([card()]);
    const active = query(root, 'tab-delivery-address');
    const inactive = query(root, 'tab-payment-methods');

    expect(active?.className).toContain('text-ink-primary');
    expect(active?.className).toContain('font-semibold');
    expect(inactive?.className).toContain('text-ink-secondary');
    expect(inactive?.className).not.toContain('font-semibold');
  });

  /**
   * CONTRACT: The inactive indicator is `bg-transparent`, not absent. Dropping
   * the element instead collapses the tab's height by the indicator's 2px and
   * the labels jump as the buyer switches tabs.
   */
  it('shows a filled indicator under the active tab and a transparent one under the other', async () => {
    const root = await render([card()]);

    expect(query(root, 'tab-indicator-delivery-address')?.className).toContain('bg-brand-navy');
    expect(query(root, 'tab-indicator-payment-methods')?.className).toContain('bg-transparent');

    await openPaymentMethods(root);

    expect(query(root, 'tab-indicator-delivery-address')?.className).toContain('bg-transparent');
    expect(query(root, 'tab-indicator-payment-methods')?.className).toContain('bg-brand-navy');
  });

  it('switches to the SAVED CARDS section when the payment-methods tab is clicked', async () => {
    const root = await render([card()]);

    expect(query(root, 'saved-cards-section')).toBeNull();

    await openPaymentMethods(root);

    expect(query(root, 'saved-cards-section')).not.toBeNull();
    expect(query(root, 'tab-payment-methods')?.className).toContain('text-ink-primary');
  });

  it('lists the saved cards it read from the gateway, with a live count', async () => {
    const root = await render([card(), card({ id: 'pm_2', brand: 'mastercard', last4: '5556' })]);
    await openPaymentMethods(root);

    expect(rows(root)).toHaveLength(2);
    expect(query(root, 'section-count')?.textContent).toContain('2 cards');
    expect(root.textContent).toContain('Visa ···· 4242');
    expect(root.textContent).toContain('Mastercard ···· 5556');
  });

  it('counts a single card in the singular', async () => {
    const root = await render([card()]);
    await openPaymentMethods(root);

    expect(query(root, 'section-count')?.textContent).toContain('1 card');
  });

  /**
   * CONTRACT: The profile's rows carry NO radio — a card here is managed, not
   * chosen. A radio implies a selection this screen never sends anywhere.
   */
  it('renders the rows without a radio', async () => {
    const root = await render([card()]);
    await openPaymentMethods(root);

    expect(rows(root)).toHaveLength(1);
    expect(query(root, 'radio')).toBeNull();
  });

  it('renders an expired card in place, with the danger expiry text', async () => {
    const root = await render([card({ expMonth: 1, expYear: 2020 })]);
    await openPaymentMethods(root);

    const expiry = query(root, 'card-expiry');
    expect(expiry?.textContent).toContain('Expired 01 / 2020');
    expect(expiry?.className).toContain('text-danger-red');
  });

  /**
   * Decision 24's three states in the profile's own list. The same three rows the
   * checkout renders, minus the radio — so `selectable` being false must not cost
   * the list its default badge, its set-default link or its expired styling.
   */
  it('renders the default, plain and expired states side by side, all radio-free', async () => {
    const root = await render([
      card({ id: 'pm_default', isDefault: true }),
      card({ id: 'pm_other', last4: '5556' }),
      card({ id: 'pm_expired', last4: '0005', expMonth: 1, expYear: 2020 }),
    ]);
    await openPaymentMethods(root);

    const [defaultRow, plainRow, expiredRow] = rows(root).map((host) => ({
      row: host.querySelector('[data-testid="saved-card-row"]'),
      bubble: host.querySelector('[data-testid="brand-bubble"]'),
      expiry: host.querySelector('[data-testid="card-expiry"]'),
      badge: host.querySelector('[data-testid="default-badge"]'),
      setDefault: host.querySelector('[data-testid="set-default-link"]'),
      remove: host.querySelector('[data-testid="remove-button"]'),
      radio: host.querySelector('[data-testid="radio"]'),
    }));

    expect(defaultRow.badge).not.toBeNull();
    expect(defaultRow.setDefault).toBeNull();

    expect(plainRow.badge).toBeNull();
    expect(plainRow.setDefault).not.toBeNull();

    // CONTRACT: An expired card keeps its Remove button and loses its
    // set-default link. Removing it is the buyer's own call (Decision 24 deletes
    // nothing automatically), but promoting it to default is not offered.
    expect(expiredRow.bubble?.className).toContain('bg-surface-subtle');
    expect(expiredRow.expiry?.className).toContain('text-danger-red');
    expect(expiredRow.setDefault).toBeNull();
    expect(expiredRow.remove).not.toBeNull();

    expect(
      [defaultRow.radio, plainRow.radio, expiredRow.radio],
      'a radio reached the profile list — `selectable` must stay false here',
    ).toEqual([null, null, null]);
  });

  it('shows the security note', async () => {
    const root = await render([card()]);
    await openPaymentMethods(root);

    expect(query(root, 'security-note')?.textContent).toContain(
      'Cards are stored by Stripe. 3MRAI never sees your full card number.',
    );
  });

  it('sets a default and re-reads the list', async () => {
    const root = await render([card({ isDefault: true }), card({ id: 'pm_2' })]);
    await openPaymentMethods(root);

    Array.from(root.querySelectorAll<HTMLElement>('[data-testid="set-default-link"]'))[0].click();
    await settle(fixture);

    expect(paymentMethods.setDefault).toHaveBeenCalledWith('pm_2');
    expect(paymentMethods.list).toHaveBeenCalledTimes(2);
  });

  it('removes a card and re-reads the list', async () => {
    const root = await render([card()]);
    await openPaymentMethods(root);

    query(root, 'remove-button')?.click();
    await settle(fixture);

    expect(paymentMethods.remove).toHaveBeenCalledWith('pm_1');
    expect(paymentMethods.list).toHaveBeenCalledTimes(2);
  });

  /**
   * CONTRACT: Report to ErrorHandler as well as rendering the message. A caught
   * ApiError that only reaches the screen is absent from rum_logs while the
   * dashboards stay green. See [[browser-rum]]
   */
  it('reports a failed list read and shows a message', async () => {
    paymentMethods.list.mockReturnValue(throwError(() => new ApiError(503, null, 'HTTP 503')));
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(PaymentMethodsTab);
    fixture.detectChanges();
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    await openPaymentMethods(root);

    expect(query(root, 'cards-error')).not.toBeNull();
    expect(handleError).toHaveBeenCalled();
  });

  /** The tab reads the list once, on mount — switching tabs is not a refetch. */
  it('reads the list once across a tab switch', async () => {
    const root = await render([card()]);
    await openPaymentMethods(root);
    query(root, 'tab-delivery-address')?.click();
    fixture.detectChanges();
    await settle(fixture);

    expect(paymentMethods.list).toHaveBeenCalledTimes(1);
  });

  it('expands the inline add-card form from the Add a card button', async () => {
    const root = await render([card()]);
    await openPaymentMethods(root);

    expect(query(root, 'profile-add-card')).toBeNull();

    query(root, 'add-card-button')?.querySelector('button')?.click();
    fixture.detectChanges();
    await settle(fixture);

    expect(query(root, 'profile-add-card')).not.toBeNull();
    expect(query(root, 'add-card-button')).toBeNull();
  });

  it('collapses the add-card form on Cancel, restoring the button', async () => {
    const root = await render([card()]);
    await openPaymentMethods(root);
    query(root, 'add-card-button')?.querySelector('button')?.click();
    fixture.detectChanges();
    await settle(fixture);

    query(root, 'cancel-link')?.click();
    fixture.detectChanges();
    await settle(fixture);

    expect(query(root, 'profile-add-card')).toBeNull();
    expect(query(root, 'add-card-button')).not.toBeNull();
  });

  /**
   * CONTRACT: The list is RE-READ after a card is added, never patched locally
   * — Users assigns `isDefault` on attach, so a locally appended row can render
   * a Default badge the server did not grant.
   */
  it('re-reads the list after a card is added and collapses the form', async () => {
    paymentMethods.list
      .mockReturnValueOnce(of([card()]))
      .mockReturnValue(of([card(), card({ id: 'pm_new', brand: 'mastercard', last4: '5556' })]));
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(PaymentMethodsTab);
    fixture.detectChanges();
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    await openPaymentMethods(root);

    query(root, 'add-card-button')?.querySelector('button')?.click();
    fixture.detectChanges();
    await settle(fixture);
    query(root, 'add-card-button-submit')?.click();
    await settle(fixture);

    expect(paymentMethods.attach).toHaveBeenCalledWith('pm_new');
    expect(paymentMethods.list).toHaveBeenCalledTimes(2);
    expect(query(root, 'profile-add-card')).toBeNull();
    expect(rows(root)).toHaveLength(2);
  });

  /** With no card on file the form IS the surface — there is nothing to manage. */
  it('shows the add-card form directly when there are no saved cards', async () => {
    const root = await render([]);
    await openPaymentMethods(root);

    expect(query(root, 'profile-add-card')).not.toBeNull();
    expect(query(root, 'add-card-button')).toBeNull();
    expect(rows(root)).toHaveLength(0);
  });

  /**
   * CONTRACT: An empty list locks the form's default checkbox on — Users makes a
   * first card the default inside the attach, so no separate setDefault runs.
   */
  it('requires the default on the first card and skips setDefault', async () => {
    const root = await render([]);
    await openPaymentMethods(root);

    expect(addCardForm()?.defaultRequired()).toBe(true);
    expect(query(root, 'default-card-checkbox')?.getAttribute('aria-disabled')).toBe('true');

    query(root, 'add-card-button-submit')?.click();
    await settle(fixture);

    expect(paymentMethods.attach).toHaveBeenCalledWith('pm_new');
    expect(paymentMethods.setDefault).not.toHaveBeenCalled();
  });

  it('leaves the default opt-out and promotes a checked later card', async () => {
    const root = await render([card({ isDefault: true })]);
    await openPaymentMethods(root);
    query(root, 'add-card-button')?.querySelector('button')?.click();
    fixture.detectChanges();
    await settle(fixture);

    expect(addCardForm()?.defaultRequired()).toBe(false);
    expect(query(root, 'default-card-checkbox')?.getAttribute('aria-checked')).toBe('true');

    query(root, 'add-card-button-submit')?.click();
    await settle(fixture);

    expect(paymentMethods.setDefault).toHaveBeenCalledWith('pm_new');
  });
});
