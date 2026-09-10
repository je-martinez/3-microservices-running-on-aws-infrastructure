import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import {
  LucideBuilding2,
  LucideCheck,
  LucideChevronLeft,
  LucideCreditCard,
  LucideMap,
  LucideMapPin,
  LucidePhone,
  LucideRefreshCw,
  LucideShieldCheck,
  LucideShoppingBag,
  LucideTriangleAlert,
  provideLucideIcons,
} from '@lucide/angular';

import { CheckoutPaymentPage } from './checkout-payment';
import { USER, awaitRequest, fillField, settle } from '../auth/testing';
import { SessionStore } from '../../core/auth/session-store';
import { StreetAutocomplete } from '../../shared/ui/street-autocomplete';
import type { Address, User } from '../../core/api/types';
import {
  EMPTY_CART,
  SCREEN_TEST_PROVIDERS,
  cart,
  cartLine,
  money,
  unavailableLine,
} from '../../shared/testing/fixtures';

describe('CheckoutPaymentPage', () => {
  let fixture: ComponentFixture<CheckoutPaymentPage>;
  let controller: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        ...SCREEN_TEST_PROVIDERS,
        provideLucideIcons(
          LucideBuilding2,
          LucideCheck,
          LucideChevronLeft,
          LucideCreditCard,
          LucideMap,
          LucideMapPin,
          LucidePhone,
          LucideRefreshCw,
          LucideShieldCheck,
          LucideShoppingBag,
          LucideTriangleAlert,
        ),
      ],
    });
    await TestBed.compileComponents();
    controller = TestBed.inject(HttpTestingController);
    signIn(ADDRESS);
  });

  afterEach(() => {
    controller.verify({ ignoreCancelled: true });
    TestBed.resetTestingModule();
  });

  /** The saved address the signed-in profile carries by default. */
  const ADDRESS: Address = {
    line1: 'Av. Rómulo Betancourt 1204',
    line2: 'Apto 5B',
    city: 'Santo Domingo',
    state: 'Distrito Nacional',
    postalCode: '10604',
    country: 'DO',
  };

  /**
   * CONTRACT: Seed the session BEFORE creating the component. The address card
   * branches at first render, so a session patched afterwards renders the form
   * this page then keeps showing over an address it already has.
   */
  function signIn(address: Address | null, overrides: Partial<User> = {}): void {
    TestBed.inject(SessionStore).setUser({
      ...USER,
      fullName: 'Jose Martinez',
      address,
      ...overrides,
    });
  }

  /** Creates the page, deferred so each test can seed its own session first. */
  function render(): void {
    fixture = TestBed.createComponent(CheckoutPaymentPage);
    fixture.detectChanges();
  }

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('reads the cart from /v1/cart with no duplicated prefix', async () => {
    render();
    const request = await awaitRequest(fixture, controller, '/v1/cart');
    expect(request.request.method).toBe('GET');
    expect(request.request.url).not.toContain('/v1/v1/');
    request.flush(EMPTY_CART);
    await settle(fixture);
  });

  it('renders the summary from the cart rather than the catalogue', async () => {
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    expect(root().querySelectorAll('app-cart-line')).toHaveLength(1);
    // No catalogue call: the summary is the cart, not three stand-in products.
    controller.verify();
  });

  it('sanitizes and constrains every plain card field', async () => {
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    const fillCardInput = (testId: string, value: string): HTMLInputElement => {
      const input = root().querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
      if (!input) throw new Error(`No card input with test id ${testId}`);
      input.value = value;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      return input;
    };

    const number = fillCardInput('card-number', '4242-4242a4242 4242 1239');
    const expiry = fillCardInput('card-expiry', '1a2/3b45');
    const cvc = fillCardInput('card-cvc', '1a2-345');

    expect(number.value).toBe('4242 4242 4242 4242 123');
    expect(number.inputMode).toBe('numeric');
    expect(number.maxLength).toBe(23);
    expect(expiry.value).toBe('12 / 34');
    expect(expiry.maxLength).toBe(7);
    expect(cvc.value).toBe('1234');
    expect(cvc.maxLength).toBe(4);

    const zip = Array.from(root().querySelectorAll<HTMLInputElement>('input')).find(
      (input) => input.value === '10604',
    );
    expect(zip?.readOnly).toBe(true);
    expect(zip?.inputMode).toBe('numeric');
    expect(zip?.maxLength).toBe(5);
  });

  /**
   * CONTRACT: Every figure is the server's `formatted` string. This one is
   * unreachable by any local arithmetic on `cents`, so a page rebuilding it
   * fails here while passing on an ordinary amount. See [[money-representation]]
   */
  it('renders the server totals verbatim', async () => {
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(
      cart([cartLine()], { total: money(29148, 'USD 291.48 exactly') }),
    );
    await settle(fixture);

    expect(root().textContent).toContain('USD 291.48 exactly');
  });

  /**
   * CONTRACT: An empty cart still reports shipping and a non-zero total. The
   * payment form is withheld entirely — a Pay button beside that figure offers
   * to charge for nothing.
   */
  it('withholds the payment form and the total on an empty cart', async () => {
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(EMPTY_CART);
    await settle(fixture);

    expect(root().textContent).toContain('Your cart is empty');
    expect(root().textContent).not.toContain('$15.00');
    expect(root().querySelector('[data-testid="checkout-pay"]')).toBeNull();
    expect(root().querySelector('[data-testid="checkout-plain"]')).toBeNull();
  });

  it('shows an error with a retry when the cart cannot be read', async () => {
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(
      { message: 'down' },
      { status: 503, statusText: 'Service Unavailable' },
    );
    await settle(fixture);

    expect(root().textContent).toContain('We could not load your cart');

    root().querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(EMPTY_CART);
    await settle(fixture);
    expect(root().textContent).toContain('Your cart is empty');
  });

  /** The render trap again: a low-stock line is fully priced and must show it. */
  it('keeps the price of a low-stock line in the summary', async () => {
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(
      cart([unavailableLine('insufficient_stock')]),
    );
    await settle(fixture);

    expect(root().textContent).toContain('$256.00');
    expect(root().textContent).toContain('Not enough left in stock');
  });

  /**
   * CONTRACT: POST /orders does NOT read the cart — the lines go in the body or
   * it answers 400. On success the server has deleted the cart, so the page
   * navigates away rather than re-reading it.
   */
  it('pays by posting the cart lines explicitly, then leaves for the order', async () => {
    render();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    root().querySelector<HTMLButtonElement>('[data-testid="checkout-pay"]')?.click();
    await settle(fixture);

    const order = await awaitRequest(fixture, controller, '/v1/orders');
    expect(order.request.method).toBe('POST');
    expect(order.request.body).toEqual({ lines: [{ productId: 'prd_V1StGXR8Z5', quantity: 2 }] });
    order.flush({ id: 'ord_3kLpQx8vRn' });
    await settle(fixture);

    expect(navigate).toHaveBeenCalledWith(['/orders', 'ord_3kLpQx8vRn']);
    controller.verify();
  });

  /**
   * CONTRACT: `canCheckout: true` is a HINT — stock can go between the read and
   * the charge. The 409 reaches the buyer as a sentence, and it SURVIVES the
   * re-read it triggers rather than being unmounted by the loading branch.
   */
  it('surfaces a checkout that fails on a cart reported as buyable', async () => {
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    root().querySelector<HTMLButtonElement>('[data-testid="checkout-pay"]')?.click();
    await settle(fixture);

    (await awaitRequest(fixture, controller, '/v1/orders')).flush(
      { message: 'stock' },
      { status: 409, statusText: 'Conflict' },
    );
    await settle(fixture);

    expect(root().textContent).toContain('Someone bought the last one');

    (await awaitRequest(fixture, controller, '/v1/cart')).flush(
      cart([unavailableLine('out_of_stock')]),
    );
    await settle(fixture);

    // Still readable after the reload finished.
    expect(root().textContent).toContain('Someone bought the last one');
  });

  it('disables paying when the server says the cart cannot be bought', async () => {
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(
      cart([cartLine(), unavailableLine('out_of_stock')]),
    );
    await settle(fixture);

    const button = root().querySelector<HTMLButtonElement>('[data-testid="checkout-pay"]');
    expect(button?.disabled).toBe(true);
  });

  /**
   * CONTRACT: The card renders the SIGNED-IN user's address. It stood in with a
   * literal ("Jose Martinez / Av. Rómulo Betancourt 1204…") that rendered
   * identically for every buyer, so a page bound to nothing passed review — the
   * assertion below therefore uses an address no literal in the source holds.
   */
  it("renders the user's own delivery address rather than stand-in copy", async () => {
    signIn({
      line1: 'Calle Duarte 87',
      line2: 'Suite 3',
      city: 'Santiago',
      state: '',
      postalCode: '51000',
      country: 'DO',
    });
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    const card = root().querySelector('[data-testid="checkout-address"]');
    expect(card?.textContent).toContain('Calle Duarte 87');
    expect(card?.textContent).toContain('Suite 3');
    expect(card?.textContent).toContain('Santiago');
    expect(card?.textContent).toContain('51000');
    expect(root().textContent).not.toContain('Rómulo Betancourt');
  });

  it("renders the profile's phone number beside the address", async () => {
    signIn(ADDRESS, { phoneNumber: '+1 809 555 0142' });
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    expect(root().querySelector('[data-testid="checkout-address"]')?.textContent).toContain(
      '+1 809 555 0142',
    );
  });

  it('renders the address form instead of the card when the profile has none', async () => {
    signIn(null);
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    expect(root().textContent).toContain('Add a delivery address');
    // One input per field of the address contract, minus `country` — which the
    // design deliberately has no frame for, because the autocomplete knows it.
    expect(root().querySelectorAll('app-street-autocomplete')).toHaveLength(1);
    expect(root().querySelectorAll('app-field')).toHaveLength(4);
    expect(root().querySelectorAll('app-phone-field')).toHaveLength(1);
  });

  /**
   * CONTRACT: `+1 809` is the Dominican Republic, not the US, and the two share
   * a calling code. This asserts the DERIVED flag on the real screen, because a
   * component-level test cannot catch a call site that never passes the value
   * through. See [[2026-09-05-phone-input-country-flag]]
   */
  it('derives the country flag from the phone number typed into the form', async () => {
    signIn(null);
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    fillField(fixture, 'Phone number', '+1 809 555 0142');

    const phone = root().querySelector('app-phone-field');
    expect(phone?.querySelector('[data-country]')?.getAttribute('data-country')).toBe('DO');
    expect(phone?.querySelector('input')?.value).toBe('+1 809 555 0142');
  });

  /**
   * CONTRACT: The address is sent as the STRUCTURED object PATCH /users/me
   * persists, not a single joined line — verified live against the service.
   * The card must then re-render off the session with NO reload.
   */
  it('saves a new address to /users/me and shows it without a reload', async () => {
    signIn(null);
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    fillField(fixture, 'Street address', 'Calle Duarte 87');
    fillField(fixture, 'City', 'Santiago');
    fillField(fixture, 'ZIP Code', '51000');
    fillField(fixture, 'Phone number', '+1 809 555 0142');

    root().querySelector<HTMLButtonElement>('[data-testid="checkout-save-address"]')?.click();
    await settle(fixture);

    const patch = await awaitRequest(fixture, controller, '/v1/users/me');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({
      address: {
        line1: 'Calle Duarte 87',
        line2: null,
        city: 'Santiago',
        state: '',
        postalCode: '51000',
        // CONTRACT: '' for a hand-typed address, never a guess. It defaulted to
        // 'DO', which stored every foreign address as Dominican; the form has no
        // country input by design, so only a suggestion can supply one.
        country: '',
      },
      phoneNumber: '+1 809 555 0142',
    });

    const saved: Address = { ...ADDRESS, line1: 'Calle Duarte 87', city: 'Santiago', postalCode: '51000' };
    patch.flush({ ...USER, fullName: 'Jose Martinez', address: saved });
    await settle(fixture);

    expect(TestBed.inject(SessionStore).user()?.address).toEqual(saved);
    expect(root().textContent).not.toContain('Add a delivery address');
    expect(root().querySelector('[data-testid="checkout-address"]')?.textContent).toContain(
      'Calle Duarte 87',
    );
  });

  /**
   * CONTRACT: A chosen suggestion's city/state/postal code are KNOWN and go to
   * the service verbatim, each into its own field. `country` rides along too —
   * it is the one contract field the form has no input for.
   */
  it('sends a chosen suggestion structurally, keeping the typed house number', async () => {
    signIn(null);
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    const autocomplete = fixture.debugElement.query(By.directive(StreetAutocomplete));
    autocomplete.componentInstance.addressSelected.emit({
      line1: 'Avenida Winston Churchill',
      line2: null,
      city: 'Santo Domingo',
      state: 'Distrito Nacional',
      postalCode: '10148',
      country: 'DO',
    } satisfies Address);
    await settle(fixture);

    // The visible fields show what will be saved, so the buyer can correct it.
    expect(root().querySelector<HTMLInputElement>('app-street-autocomplete input')?.value).toBe(
      'Avenida Winston Churchill',
    );
    const fieldValue = (label: string) =>
      Array.from(root().querySelectorAll('app-field')).find((f) =>
        f.textContent?.includes(label),
      )?.querySelector('input')?.value;
    expect(fieldValue('City')).toBe('Santo Domingo');
    expect(fieldValue('State')).toBe('Distrito Nacional');
    expect(fieldValue('ZIP Code')).toBe('10148');

    // Adding the house number keeps the resolution — the whole point of a
    // STREET autocomplete against a dataset with no house numbers.
    fillField(fixture, 'Street address', 'Avenida Winston Churchill 42');

    root().querySelector<HTMLButtonElement>('[data-testid="checkout-save-address"]')?.click();
    await settle(fixture);

    const patch = await awaitRequest(fixture, controller, '/v1/users/me');
    expect(patch.request.body).toEqual({
      address: {
        line1: 'Avenida Winston Churchill 42',
        line2: null,
        city: 'Santo Domingo',
        state: 'Distrito Nacional',
        postalCode: '10148',
        country: 'DO',
      },
    });
    patch.flush({ ...USER, address: ADDRESS });
    await settle(fixture);
  });

  /**
   * CONTRACT: Hand-editing a resolved field drops the resolution, so `country`
   * goes back to '': the address is a different one, and guessing its country
   * stores foreign addresses as Dominican. Every OTHER field keeps what the
   * buyer sees, `state` included.
   */
  it('drops the resolution when a resolved field is edited by hand', async () => {
    signIn(null);
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    const autocomplete = fixture.debugElement.query(By.directive(StreetAutocomplete));
    autocomplete.componentInstance.addressSelected.emit({
      line1: 'Avenida Winston Churchill',
      line2: null,
      city: 'Santo Domingo',
      state: 'Distrito Nacional',
      postalCode: '10148',
      country: 'DO',
    } satisfies Address);
    await settle(fixture);

    fillField(fixture, 'City', 'Santiago');
    fillField(fixture, 'ZIP Code', '51000');

    root().querySelector<HTMLButtonElement>('[data-testid="checkout-save-address"]')?.click();
    await settle(fixture);

    const patch = await awaitRequest(fixture, controller, '/v1/users/me');
    expect(patch.request.body).toEqual({
      address: {
        line1: 'Avenida Winston Churchill',
        line2: null,
        // The province the buyer can still see stays; only `country` is lost,
        // because only `country` had no input to survive in.
        city: 'Santiago',
        state: 'Distrito Nacional',
        postalCode: '51000',
        country: '',
      },
    });
    patch.flush({ ...USER, address: ADDRESS });
    await settle(fixture);
  });

  /**
   * CONTRACT: No address, no order. The address is collected precisely so the
   * goods have somewhere to go; a paid order with no destination is one the
   * warehouse cannot ship and support has to unpick by hand.
   */
  it('refuses to place an order while the delivery address is missing', async () => {
    signIn(null);
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    const button = root().querySelector<HTMLButtonElement>('[data-testid="checkout-pay"]');
    expect(button?.disabled).toBe(true);

    button?.click();
    await settle(fixture);
    // No POST /orders was issued: verify() would report it as unexpected.
    controller.verify();
  });

  it('enables paying once an address has been saved', async () => {
    signIn(null);
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    fillField(fixture, 'Street address', 'Calle Duarte 87');
    fillField(fixture, 'City', 'Santiago');
    fillField(fixture, 'ZIP Code', '51000');
    root().querySelector<HTMLButtonElement>('[data-testid="checkout-save-address"]')?.click();
    await settle(fixture);

    (await awaitRequest(fixture, controller, '/v1/users/me')).flush({
      ...USER,
      address: ADDRESS,
    });
    await settle(fixture);

    expect(root().querySelector<HTMLButtonElement>('[data-testid="checkout-pay"]')?.disabled).toBe(
      false,
    );
  });

  /** The stepper's state per label, read off the rendered `data-*` attributes. */
  function stepStates(): Record<string, string> {
    const steps = root().querySelectorAll<HTMLElement>('[data-testid="checkout-steps"] [data-step]');
    return Object.fromEntries(
      Array.from(steps).map((step) => [
        step.dataset['step'] ?? '',
        step.dataset['state'] ?? '',
      ]),
    );
  }

  /**
   * CONTRACT: The stepper is DERIVED, never hardcoded. It shipped as a literal
   * "Cart ✓ — Address ✓ — Payment", so on a profile with no address it asserted
   * the address step complete while the form below was still asking for one.
   */
  it('marks Address current and Payment upcoming while no address is on file', async () => {
    signIn(null);
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    expect(stepStates()).toEqual({ Cart: 'complete', Address: 'current', Payment: 'upcoming' });

    // The check glyph is what claims completion — Address must not render one.
    const address = root().querySelector<HTMLElement>('[data-step="Address"]');
    expect(address?.querySelector('svg')?.getAttribute('data-lucide-name')).not.toBe('check');
    // Exactly one step is current, so the buyer is never pointed at two places.
    expect(root().querySelectorAll('[aria-current="step"]')).toHaveLength(1);
  });

  it('marks Address complete and Payment current once an address is on file', async () => {
    signIn(ADDRESS);
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    expect(stepStates()).toEqual({ Cart: 'complete', Address: 'complete', Payment: 'current' });
    expect(root().querySelectorAll('[aria-current="step"]')).toHaveLength(1);
  });

  /**
   * CONTRACT: Seeding rejoins city and postal code the way onAddressSuggested()
   * splits them, so re-saving an untouched form round-trips to the same values
   * instead of silently rewriting the city as "Santo Domingo 10604".
   */
  it('seeds the form from the saved address when editing begins', async () => {
    signIn(ADDRESS, { phoneNumber: '+1 809 555 0142' });
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    root().querySelector<HTMLButtonElement>('[data-testid="checkout-edit-address"]')?.click();
    await settle(fixture);

    expect(root().querySelector<HTMLInputElement>('app-street-autocomplete input')?.value).toBe(
      'Av. Rómulo Betancourt 1204',
    );
    const seeded = Array.from(root().querySelectorAll('app-field')).map(
      (f) => f.querySelector('input')?.value,
    );
    expect(seeded).toEqual(['Apto 5B', 'Santo Domingo', 'Distrito Nacional', '10604']);
    expect(root().querySelector<HTMLInputElement>('app-phone-field input')?.value).toBe(
      '+1 809 555 0142',
    );
  });

  /**
   * CONTRACT: Editing PATCHes the same single `address` field — Users has no
   * addresses table, so there is no second address to create. One PATCH, and
   * the card afterwards shows the edited value rather than both.
   */
  it('updates the existing address in place rather than creating a second one', async () => {
    signIn(ADDRESS);
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    root().querySelector<HTMLButtonElement>('[data-testid="checkout-edit-address"]')?.click();
    await settle(fixture);

    fillField(fixture, 'Street address', 'Calle Duarte 87');
    fillField(fixture, 'City', 'Santiago');
    fillField(fixture, 'ZIP Code', '51000');
    root().querySelector<HTMLButtonElement>('[data-testid="checkout-save-address"]')?.click();
    await settle(fixture);

    const patch = await awaitRequest(fixture, controller, '/v1/users/me');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({
      address: {
        line1: 'Calle Duarte 87',
        // CONTRACT: The fields the buyer did NOT touch keep their saved values.
        // Without an input to hold them, editing any field erases `line2` and
        // `state` — dropping the apartment and the province on every save.
        line2: 'Apto 5B',
        city: 'Santiago',
        state: 'Distrito Nacional',
        postalCode: '51000',
        // '' for a hand-typed address, never a guess — only a suggestion knows
        // the country, and this address is a different one.
        country: '',
      },
    });

    const saved: Address = { ...ADDRESS, line1: 'Calle Duarte 87', city: 'Santiago', postalCode: '51000' };
    patch.flush({ ...USER, fullName: 'Jose Martinez', address: saved });
    await settle(fixture);

    // Back to the card, showing the edited address — and only one PATCH went out.
    expect(root().querySelector('[data-testid="checkout-edit-address"]')).not.toBeNull();
    expect(root().querySelector('[data-testid="checkout-address"]')?.textContent).toContain(
      'Calle Duarte 87',
    );
    expect(root().textContent).not.toContain('Rómulo Betancourt');
    controller.verify();
  });

  it('leaves the saved address untouched when an edit is cancelled', async () => {
    signIn(ADDRESS);
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    root().querySelector<HTMLButtonElement>('[data-testid="checkout-edit-address"]')?.click();
    await settle(fixture);
    fillField(fixture, 'Street address', 'Calle Duarte 87');

    root().querySelector<HTMLButtonElement>('[data-testid="checkout-cancel-edit-address"]')?.click();
    await settle(fixture);

    expect(TestBed.inject(SessionStore).user()?.address).toEqual(ADDRESS);
    expect(root().querySelector('[data-testid="checkout-address"]')?.textContent).toContain(
      'Av. Rómulo Betancourt 1204',
    );
    expect(root().textContent).not.toContain('Calle Duarte 87');
    // Nothing was sent: verify() reports any PATCH as unexpected.
    controller.verify();
  });

  /** The disabled Pay button states its one clearable blocker, not nothing. */
  it('names the missing address as the reason paying is blocked', async () => {
    signIn(null);
    render();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    expect(root().querySelector<HTMLButtonElement>('[data-testid="checkout-pay"]')?.disabled).toBe(
      true,
    );
    expect(root().querySelector('[data-testid="checkout-address-required"]')?.textContent).toContain(
      'Add a delivery address',
    );

    signIn(ADDRESS);
    await settle(fixture);
    expect(root().querySelector('[data-testid="checkout-address-required"]')).toBeNull();
  });
});
