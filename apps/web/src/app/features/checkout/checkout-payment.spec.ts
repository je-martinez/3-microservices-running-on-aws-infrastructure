import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import {
  LucideCheck,
  LucideChevronLeft,
  LucideCreditCard,
  LucideRefreshCw,
  LucideShieldCheck,
  LucideShoppingBag,
  LucideTriangleAlert,
  provideLucideIcons,
} from '@lucide/angular';

import { CheckoutPaymentPage } from './checkout-payment';
import { awaitRequest, settle } from '../auth/testing';
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
          LucideCheck,
          LucideChevronLeft,
          LucideCreditCard,
          LucideRefreshCw,
          LucideShieldCheck,
          LucideShoppingBag,
          LucideTriangleAlert,
        ),
      ],
    });
    await TestBed.compileComponents();
    controller = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CheckoutPaymentPage);
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

  it('renders the summary from the cart rather than the catalogue', async () => {
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(cart([cartLine()]));
    await settle(fixture);

    expect(root().querySelectorAll('app-cart-line')).toHaveLength(1);
    // No catalogue call: the summary is the cart, not three stand-in products.
    controller.verify();
  });

  /**
   * CONTRACT: Every figure is the server's `formatted` string. This one is
   * unreachable by any local arithmetic on `cents`, so a page rebuilding it
   * fails here while passing on an ordinary amount. See [[money-representation]]
   */
  it('renders the server totals verbatim', async () => {
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
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(EMPTY_CART);
    await settle(fixture);

    expect(root().textContent).toContain('Your cart is empty');
    expect(root().textContent).not.toContain('$15.00');
    expect(root().querySelector('[data-testid="checkout-pay"]')).toBeNull();
    expect(root().querySelector('[data-testid="checkout-plain"]')).toBeNull();
  });

  it('shows an error with a retry when the cart cannot be read', async () => {
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
    (await awaitRequest(fixture, controller, '/v1/cart')).flush(
      cart([cartLine(), unavailableLine('out_of_stock')]),
    );
    await settle(fixture);

    const button = root().querySelector<HTMLButtonElement>('[data-testid="checkout-pay"]');
    expect(button?.disabled).toBe(true);
  });
});
