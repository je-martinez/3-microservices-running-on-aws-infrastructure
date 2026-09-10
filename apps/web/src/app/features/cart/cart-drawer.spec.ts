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
import { awaitRequest, settle, textOf } from '../auth/testing';
import {
  EMPTY_CART,
  SCREEN_TEST_PROVIDERS,
  cart,
  cartLine,
  money,
  unavailableLine,
} from '../../shared/testing/fixtures';

/** Comfortably past CartStore's quantity debounce. */
const DEBOUNCE_ADVANCE_MS = 500;

/**
 * Fires CartStore's pending quantity debounce, then re-renders.
 *
 * CONTRACT: Restore real timers before pumping. `settle()` awaits a `setTimeout`
 * of its own, and under fake timers nothing advances it — the helper hangs until
 * the test times out, reporting a stall rather than the missing PUT the
 * assertion is about. See [[2026-09-04-angular-http-testing-traps]]
 */
async function flushDebounce(fixture: ComponentFixture<unknown>): Promise<void> {
  vi.advanceTimersByTime(DEBOUNCE_ADVANCE_MS);
  vi.useRealTimers();
  await settle(fixture);
}

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
    // CONTRACT: Restore real timers here, not at the end of each debounce test.
    // A test failing mid-window leaves them faked, and every later spec in the
    // run then hangs on its own setTimeout — a cascade naming the wrong test.
    vi.useRealTimers();
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

  /**
   * The stepper's write is DEBOUNCED, so the click alone produces no request —
   * `flushDebounce` fires the timer. The body assertion is unchanged: one click
   * on a quantity of 2 still replaces the whole cart at 3.
   */
  it('sends a quantity change as a whole-cart replacement', async () => {
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine({ quantity: 2 })]));
    await settle(fixture);

    vi.useFakeTimers();
    root().querySelector<HTMLButtonElement>('[aria-label="Increase quantity"]')?.click();
    await flushDebounce(fixture);

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

  describe('debounced quantity steppers', () => {
    /** Loads a one-line cart and arms fake timers for the debounce window. */
    async function loadedAt(quantity: number): Promise<void> {
      (await awaitRequest(fixture, controller, '/v1/cart')).flush(
        cart([cartLine({ quantity, unitsInStock: 20 })]),
      );
      await settle(fixture);
      vi.useFakeTimers();
    }

    function clickIncrement(times: number): void {
      for (let click = 0; click < times; click += 1) {
        root().querySelector<HTMLButtonElement>('[aria-label="Increase quantity"]')?.click();
        fixture.detectChanges();
      }
    }

    /**
     * CONTRACT: Five clicks are ONE PUT carrying the FINAL quantity. Asserting
     * the request COUNT is what pins the coalescing — a store writing per click
     * still ends at quantity 7 and would pass a body-only assertion while making
     * the buyer wait out five sequential round trips.
     */
    it('coalesces five rapid increments into one PUT at the final quantity', async () => {
      await loadedAt(2);

      clickIncrement(5);
      await flushDebounce(fixture);

      const puts = controller.match((r) => r.url === '/v1/cart' && r.method === 'PUT');
      expect(puts).toHaveLength(1);
      expect(puts[0].request.body).toEqual({
        items: [{ productId: 'prd_V1StGXR8Z5', quantity: 7 }],
      });
      puts[0].flush(cart([cartLine({ quantity: 7, unitsInStock: 20 })]));
      await settle(fixture);
    });

    /**
     * CONTRACT: The displayed number tracks the finger. A drawer rendering the
     * server's cart shows 2 for the whole debounce window, which is the stale
     * quantity this optimistic overlay exists to remove.
     */
    it('shows the clicked quantity before any PUT is sent', async () => {
      await loadedAt(2);

      clickIncrement(3);

      expect(controller.match('/v1/cart')).toHaveLength(0);
      expect(textOf(fixture, '[data-testid="cart-line-quantity"]')).toBe('5');

      await flushDebounce(fixture);
      const put = await awaitRequest(fixture, controller, '/v1/cart');
      put.flush(cart([cartLine({ quantity: 5, unitsInStock: 20 })]));
      await settle(fixture);
    });

    /**
     * CONTRACT: The server's answer replaces the optimistic view, clamp
     * included. A store keeping its own number would show a quantity the buyer
     * cannot actually buy, and checkout would then fail on it.
     */
    it('adopts a server clamp over the optimistic quantity', async () => {
      await loadedAt(2);

      clickIncrement(4);
      await flushDebounce(fixture);

      // The buyer asked for 6; the server only has 3 left and says so.
      (await awaitRequest(fixture, controller, '/v1/cart')).flush(
        cart([cartLine({ quantity: 3, unitsInStock: 3 })]),
      );
      await settle(fixture);

      // Asserted on the quantity element, not the line's text: "$256.00"
      // contains a 6, so a whole-line assertion cannot tell 6 from the price.
      expect(textOf(fixture, '[data-testid="cart-line-quantity"]')).toBe('3');
    });

    /**
     * CONTRACT: The button stays enabled through a debounced change. Gating it
     * on `saving()` disables and re-enables it on every click — the flicker,
     * and a click landing in that window does nothing at all.
     */
    it('keeps checkout enabled throughout a debounced quantity change', async () => {
      await loadedAt(2);

      const button = (): HTMLButtonElement | null =>
        root().querySelector<HTMLButtonElement>('[data-testid="cart-continue"]');
      expect(button()?.disabled).toBe(false);

      clickIncrement(3);
      expect(button()?.disabled).toBe(false);

      await flushDebounce(fixture);
      // Still enabled with the PUT in flight, which is when `saving()` is true.
      const put = await awaitRequest(fixture, controller, '/v1/cart');
      expect(button()?.disabled).toBe(false);

      put.flush(cart([cartLine({ quantity: 5, unitsInStock: 20 })]));
      await settle(fixture);
      expect(button()?.disabled).toBe(false);
    });

    /** The stepper stays live mid-write, or the optimistic update is pointless. */
    it('leaves the stepper usable while a write is in flight', async () => {
      await loadedAt(2);

      clickIncrement(1);
      await flushDebounce(fixture);
      const put = await awaitRequest(fixture, controller, '/v1/cart');

      const plus = root().querySelector<HTMLButtonElement>('[aria-label="Increase quantity"]');
      const minus = root().querySelector<HTMLButtonElement>('[aria-label="Decrease quantity"]');
      expect(plus?.disabled).toBe(false);
      expect(minus?.disabled).toBe(false);

      put.flush(cart([cartLine({ quantity: 3, unitsInStock: 20 })]));
      await settle(fixture);
    });

    /**
     * CONTRACT: Only the MONEY is skeletoned. Skeletoning the lines or the
     * button would make the panel jump on every click, which is worse than the
     * stale figure the skeleton exists to hide.
     */
    it('skeletons the totals while saving and restores the real figures after', async () => {
      await loadedAt(2);

      clickIncrement(1);
      await flushDebounce(fixture);
      const put = await awaitRequest(fixture, controller, '/v1/cart');

      // Saving: the figures are gone, the labels and the lines are not.
      const footer = (): HTMLElement | null => root().querySelector('[data-testid="cart-continue"]');
      expect(root().querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(0);
      expect(root().textContent).toContain('Total');
      expect(root().querySelector('app-cart-line')).toBeTruthy();
      expect(footer()).toBeTruthy();

      put.flush(cart([cartLine({ quantity: 3, unitsInStock: 20 })]));
      await settle(fixture);

      expect(root().querySelector('[aria-busy="true"]')).toBeNull();
      expect(root().textContent).toContain('$15.00');
    });

    /**
     * CONTRACT: The skeleton starts at the CLICK, not at the PUT. Gating it on
     * `saving()` alone leaves the whole debounce window showing a total the
     * buyer has already invalidated by changing the quantity beside it.
     */
    it('skeletons the totals from the first click, before any request is sent', async () => {
      await loadedAt(2);

      clickIncrement(1);
      fixture.detectChanges();

      expect(root().querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(0);
      expect(root().textContent).not.toContain('$15.00');
      controller.expectNone('/v1/cart');

      await flushDebounce(fixture);
      (await awaitRequest(fixture, controller, '/v1/cart')).flush(
        cart([cartLine({ quantity: 3, unitsInStock: 20 })]),
      );
      await settle(fixture);

      expect(root().querySelector('[aria-busy="true"]')).toBeNull();
    });
  });
});
