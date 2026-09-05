import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import {
  LucideArrowRight,
  LucideBuilding2,
  LucideChevronLeft,
  LucideCreditCard,
  LucideRefreshCw,
  LucideShieldCheck,
  LucideShoppingBag,
  LucideTriangleAlert,
  LucideX,
  provideLucideIcons,
} from '@lucide/angular';

import { CartDrawer } from './cart-drawer';
import { APP_CONFIG } from '../../core/config/app-config';
import { OverlayStore } from '../../core/overlay/overlay-store';
import { awaitRequest, settle } from '../auth/testing';
import {
  EMPTY_CART,
  SCREEN_TEST_PROVIDERS,
  cart,
  cartLine,
  money,
  unavailableLine,
} from '../../shared/testing/fixtures';

describe('CartDrawer', () => {
  let fixture: ComponentFixture<CartDrawer>;
  let controller: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        ...SCREEN_TEST_PROVIDERS,
        provideLucideIcons(
          LucideArrowRight,
          LucideBuilding2,
          LucideChevronLeft,
          LucideCreditCard,
          LucideRefreshCw,
          LucideShieldCheck,
          LucideShoppingBag,
          LucideTriangleAlert,
          LucideX,
        ),
      ],
    });
    await TestBed.compileComponents();
    controller = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CartDrawer);
    fixture.detectChanges();
  });

  const STRIPE_ENABLED = APP_CONFIG.stripeEnabled;

  afterEach(() => {
    withStripeEnabled(STRIPE_ENABLED);
    controller.verify({ ignoreCancelled: true });
    TestBed.resetTestingModule();
  });

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  /**
   * CONTRACT: Restore this in `afterEach`. APP_CONFIG is a module-level const
   * shared by every spec in the run, so a redefinition left in place leaks the
   * flag into unrelated files — which then pass or fail by test ORDER.
   */
  function withStripeEnabled(enabled: boolean): void {
    Object.defineProperty(APP_CONFIG, 'stripeEnabled', {
      value: enabled,
      configurable: true,
      writable: false,
    });
  }

  it('reads the cart from /v1/cart with no duplicated prefix', async () => {
    const request = await awaitRequest(fixture, controller, '/v1/cart');
    expect(request.request.method).toBe('GET');
    expect(request.request.url).not.toContain('/v1/v1/');
    request.flush(EMPTY_CART);
    await settle(fixture);
  });

  it('renders a loading state before the cart arrives', async () => {
    expect(root().querySelector('[aria-busy="true"]')).toBeTruthy();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(EMPTY_CART);
    await settle(fixture);
    expect(root().querySelector('[aria-busy="true"]')).toBeNull();
  });

  /**
   * CONTRACT: The empty cart still reports $15.00 shipping and therefore a
   * non-zero total. Presenting that total bills the buyer for an empty basket,
   * so the whole summary is withheld — this asserts the FIGURE is absent, not
   * merely that some empty copy appeared beside it.
   */
  it('shows the empty state and no total for an empty cart', async () => {
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(EMPTY_CART);
    await settle(fixture);

    expect(root().textContent).toContain('Your cart is empty');
    expect(root().textContent).not.toContain('$15.00');
    expect(root().textContent).not.toContain('Total');
    expect(root().querySelector('app-cart-line')).toBeNull();
  });

  it('renders the server totals verbatim rather than recomputing them', async () => {
    // A `formatted` no local arithmetic on `cents` could produce: a component
    // rebuilding the string from cents fails here and passes on a normal one.
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(
      cart([cartLine()], { total: money(29148, 'USD 291.48 total') }),
    );
    await settle(fixture);

    expect(root().textContent).toContain('USD 291.48 total');
  });

  it('shows an error with a retry when the cart cannot be read', async () => {
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(
      { message: 'down' },
      { status: 503, statusText: 'Service Unavailable' },
    );
    await settle(fixture);

    expect(root().querySelector('[role="alert"]')).toBeTruthy();
    expect(root().textContent).toContain('We could not load your cart');

    root().querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(EMPTY_CART);
    await settle(fixture);
    expect(root().querySelector('[role="alert"]')).toBeNull();
  });

  /**
   * CONTRACT: This is THE render trap. An insufficient_stock line arrives fully
   * priced — a drawer guarding its price on `available` blanks the money of
   * every low-stock line, and passes a test that only checks the badge appears.
   * See [[money-representation]]
   */
  it('keeps the price of a low-stock line while badging it', async () => {
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(
      cart([unavailableLine('insufficient_stock')]),
    );
    await settle(fixture);

    expect(root().textContent).toContain('$256.00');
    expect(root().textContent).toContain('Not enough left in stock');
    expect(root().textContent).toContain('Field Tote 18L');
  });

  /** The other branch: unknown_product nulls all four fields and must not throw. */
  it('renders a delisted line without a price and without throwing', async () => {
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(
      cart([unavailableLine('unknown_product')]),
    );
    await settle(fixture);

    expect(root().querySelectorAll('app-cart-line')).toHaveLength(1);
    expect(root().textContent).toContain('no longer available');
    expect(root().textContent).not.toContain('$256.00');
  });

  /**
   * CONTRACT: `canCheckout: false` disables the button. It is only a HINT in the
   * other direction — a true value never guarantees POST /orders succeeds.
   */
  it('disables checkout when the server says the cart cannot be bought', async () => {
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(
      cart([cartLine(), unavailableLine('out_of_stock')]),
    );
    await settle(fixture);

    const button = root().querySelector<HTMLButtonElement>('[data-testid="cart-continue"]');
    expect(button).toBeTruthy();
    expect(button?.disabled).toBe(true);
  });

  it('enables checkout on a cart the server says is buyable', async () => {
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    const button = root().querySelector<HTMLButtonElement>('[data-testid="cart-continue"]');
    expect(button?.disabled).toBe(false);
  });

  /**
   * CONTRACT: Continue NAVIGATES; it never posts an order. The cart holds items
   * and checkout completes the purchase — a drawer that also charges gives one
   * flow two implementations, and `controller.verify()` here is what pins that:
   * a POST /orders would leave an unverified request and fail this test.
   */
  it('leaves for /checkout on continue without posting an order', async () => {
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    root().querySelector<HTMLButtonElement>('[data-testid="cart-continue"]')?.click();
    await settle(fixture);

    expect(navigate).toHaveBeenCalledWith(['/checkout']);
    controller.verify();
  });

  /**
   * CONTRACT: The overlay closes on the way out. `/checkout` renders under the
   * same layout, so a drawer left open covers the page the buyer was just sent
   * to, behind a scrim that blocks it.
   */
  it('closes the overlay when it navigates to checkout', async () => {
    const overlay = TestBed.inject(OverlayStore);
    overlay.openCart();
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    root().querySelector<HTMLButtonElement>('[data-testid="cart-continue"]')?.click();
    await settle(fixture);

    expect(overlay.active()).toBeNull();
  });

  /**
   * CONTRACT: The Stripe flag must NOT change where continue goes. Payment
   * lives on one surface, so a drawer branching on the flag reintroduces a
   * second checkout path that only a Stripe-enabled build ever exercises.
   */
  it.each([true, false])('navigates the same way with stripeEnabled %s', async (enabled) => {
    withStripeEnabled(enabled);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    root().querySelector<HTMLButtonElement>('[data-testid="cart-continue"]')?.click();
    await settle(fixture);

    expect(navigate).toHaveBeenCalledWith(['/checkout']);
    controller.verify();
  });

  it('sends a quantity change as a whole-cart replacement', async () => {
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine({ quantity: 2 })]));
    await settle(fixture);

    root().querySelector<HTMLButtonElement>('[aria-label="Increase quantity"]')?.click();
    const put = await awaitRequest(fixture, controller, '/v1/cart');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ items: [{ productId: 'prd_V1StGXR8Z5', quantity: 3 }] });
    put.flush(cart([cartLine({ quantity: 3 })]));
    await settle(fixture);
  });

  /**
   * CONTRACT: At quantity 1 the minus button REMOVES the line. The server has no
   * per-line DELETE, so a stepper that merely stops at 1 leaves the buyer no way
   * to take an item out of the cart.
   */
  it('removes a line when the last unit is decremented away', async () => {
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine({ quantity: 1 })]));
    await settle(fixture);

    root().querySelector<HTMLButtonElement>('[aria-label^="Remove"]')?.click();
    const put = await awaitRequest(fixture, controller, '/v1/cart');
    expect(put.request.body).toEqual({ items: [] });
    put.flush(EMPTY_CART);
    await settle(fixture);

    expect(root().textContent).toContain('Your cart is empty');
  });
});
