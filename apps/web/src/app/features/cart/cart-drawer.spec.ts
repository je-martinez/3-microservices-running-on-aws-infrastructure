import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
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

  afterEach(() => {
    controller.verify({ ignoreCancelled: true });
    TestBed.resetTestingModule();
  });

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
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
   * CONTRACT: `canCheckout: true` is a HINT — stock can go between the read and
   * POST /orders. The 409 must reach the buyer as a sentence, not as an
   * unhandled rejection, and the cart is re-read so the badge tells the truth.
   */
  it('surfaces a checkout that fails on a cart reported as buyable', async () => {
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    root().querySelector<HTMLButtonElement>('[data-testid="cart-continue"]')?.click();
    await settle(fixture);

    const order = await awaitRequest(fixture, controller, '/v1/orders');
    expect(order.request.method).toBe('POST');
    // POST /orders does NOT read the cart: the lines go in the body or it 400s.
    expect(order.request.body).toEqual({
      lines: [{ productId: 'prd_V1StGXR8Z5', quantity: 2 }],
    });
    order.flush({ message: 'stock' }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);

    expect(root().textContent).toContain('Someone bought the last one');

    (await awaitRequest(fixture, controller, '/v1/cart')).flush(
      cart([unavailableLine('out_of_stock')]),
    );
    await settle(fixture);
  });

  /** Order creation deletes the cart server-side, so nothing is re-read. */
  it('drops the cart after a successful checkout without re-reading it', async () => {
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    root().querySelector<HTMLButtonElement>('[data-testid="cart-continue"]')?.click();
    await settle(fixture);

    (await awaitRequest(fixture, controller, '/v1/orders')).flush({ id: 'ord_3kLpQx8vRn' });
    await settle(fixture);

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
