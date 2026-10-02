import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { AppLayout } from './app-layout';
import { CartStore } from '../cart/cart-store';
import { awaitRequest, settle } from '../../features/auth/testing';
import { SCREEN_TEST_PROVIDERS, cart, cartLine } from '../../shared/testing/fixtures';

const CART_URL = '/v1/cart';

describe('AppLayout', () => {
  let fixture: ComponentFixture<AppLayout>;
  let controller: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        ...SCREEN_TEST_PROVIDERS,
      ],
    });
    await TestBed.compileComponents();
    controller = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AppLayout);
  });

  afterEach(() => {
    TestBed.inject(CartStore).forgetAfterCheckout();
    TestBed.resetTestingModule();
  });

  /**
   * CONTRACT: The cart is fetched at authenticated boot. The header badge and
   * every product card's stepper read `CartStore` on first paint, so loading it
   * only when the drawer opens leaves an empty badge and plain Add buttons over
   * a cart the server already holds.
   * See [[2026-09-30-cart-add-quantity-morph-design]]
   */
  it('loads the cart on boot, before anything opens the drawer', async () => {
    fixture.detectChanges();

    const request = await awaitRequest(fixture, controller, CART_URL);
    expect(request.request.method).toBe('GET');

    request.flush(cart([cartLine({ productId: 'prd_held', quantity: 3 })]));
    await settle(fixture);

    expect(TestBed.inject(CartStore).itemCount()).toBe(3);
    expect(TestBed.inject(CartStore).quantityOf()('prd_held')).toBe(3);
  });

  /**
   * CONTRACT: A failed boot load must not break the shell. The badge reads 0
   * and the app stays usable; the drawer's own load retries later.
   */
  it('survives a failed boot load', async () => {
    fixture.detectChanges();

    const request = await awaitRequest(fixture, controller, CART_URL);
    request.flush({ message: 'nope' }, { status: 500, statusText: 'Server Error' });
    await settle(fixture);

    expect(TestBed.inject(CartStore).itemCount()).toBe(0);
  });

  /**
   * CONTRACT: The badge reads the socket's state through the header. Wiring it
   * to anything else leaves a live-looking dot over a dead socket.
   */
  it('shows the live-session badge carrying the socket state', async () => {
    fixture.detectChanges();
    const request = await awaitRequest(fixture, controller, CART_URL);
    request.flush(cart([]));
    await settle(fixture);

    const indicator = (fixture.nativeElement as HTMLElement).querySelector(
      'app-live-session-badge',
    );

    expect(indicator?.querySelector('[role="status"]')?.textContent).toContain('Connecting');
    // Still scanning: the ring only closes once the socket opens.
    expect(indicator?.querySelector('.badge-scan')).not.toBeNull();
    expect(indicator?.querySelector('.badge-arc')).toBeNull();
  });

});
