import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { OrderDetailPage } from './order-detail';
import { SessionStore } from '../../core/auth/session-store';
import { settle, textOf, USER } from '../auth/testing';
import { awaitPath, ORDER_WITH_TRACKING, PRODUCT, SCREEN_TEST_PROVIDERS } from '../../shared/testing/fixtures';

const ORDER_URL = '/v1/orders/ord_3kLpQx8vRn';
const PRODUCTS_URL = '/v1/products';

/** ActivatedRoute stub: the page reads `orderId` from the param map. */
function routeStub(orderId: string) {
  const paramMap = convertToParamMap({ orderId });
  return { paramMap: of(paramMap), snapshot: { paramMap } };
}

describe('OrderDetailPage', () => {
  let fixture: ComponentFixture<OrderDetailPage>;
  let controller: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: ActivatedRoute, useValue: routeStub('ord_3kLpQx8vRn') },
        ...SCREEN_TEST_PROVIDERS,
      ],
    });
    await TestBed.compileComponents();
    controller = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(OrderDetailPage);
    fixture.detectChanges();
  });

  afterEach(() => {
    controller.verify({ ignoreCancelled: true });
    TestBed.resetTestingModule();
  });

  /** Answers both in-flight requests; the page loads them in parallel. */
  async function loadOrder(entry: object = ORDER_WITH_TRACKING): Promise<void> {
    (await awaitPath(fixture, controller, ORDER_URL)).flush(entry);
    (await awaitPath(fixture, controller, PRODUCTS_URL)).flush([PRODUCT]);
    await settle(fixture);
  }

  it('renders a loading state before the order arrives', () => {
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[aria-busy="true"]')).toBeTruthy();

    controller.expectOne((r) => r.url === ORDER_URL).flush(ORDER_WITH_TRACKING);
    controller.expectOne(PRODUCTS_URL).flush([]);
  });

  /**
   * CONTRACT: Without `includeTracking=true` the route answers a bare Order, so
   * `entry.order` reads undefined and this page renders "Order not found" on a
   * 200. See [[openapi-specs]]
   */
  it('requests the tracking envelope for the order', async () => {
    const request = await awaitPath(fixture, controller, ORDER_URL);
    expect(request.request.params.get('includeTracking')).toBe('true');
    request.flush(ORDER_WITH_TRACKING);
    (await awaitPath(fixture, controller, PRODUCTS_URL)).flush([PRODUCT]);
    await settle(fixture);
  });

  it('renders every Money field as the server formatted it', async () => {
    await loadOrder();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('$128.00'); // subtotal
    expect(root.textContent).toContain('$10.24'); // tax
    expect(root.textContent).toContain('$5.00'); // shipping
    expect(root.textContent).toContain('$143.24'); // order total
    expect(root.textContent).toContain('$138.24'); // line total, no shipping
  });

  it('labels free shipping off cents while still showing server strings', async () => {
    await loadOrder({
      ...ORDER_WITH_TRACKING,
      order: {
        ...ORDER_WITH_TRACKING.order,
        shipping: { cents: 0, amount: '0.00', formatted: '$0.00', currency: 'USD' },
      },
    });

    expect(fixture.nativeElement.textContent).toContain('Free');
  });

  it('joins lines against the catalogue to name them', async () => {
    await loadOrder();
    expect(fixture.nativeElement.textContent).toContain('Field Tote 18L');
  });

  it('names a delisted line rather than dropping it', async () => {
    (await awaitPath(fixture, controller, ORDER_URL)).flush(ORDER_WITH_TRACKING);
    (await awaitPath(fixture, controller, PRODUCTS_URL)).flush([]);
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('Product no longer listed');
  });

  it('renders the tracking timeline from history', async () => {
    await loadOrder();
    expect(fixture.nativeElement.textContent).toContain('Placed');
  });

  it('reads the delivery address from the signed-in user', async () => {
    TestBed.inject(SessionStore).setUser({
      ...USER,
      fullName: 'Morgan Reyes',
      address: {
        line1: '482 Birch Hollow Lane',
        line2: null,
        city: 'Portland',
        state: 'OR',
        postalCode: '97201',
        country: 'US',
      },
    });
    await loadOrder();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Morgan Reyes');
    expect(root.textContent).toContain('482 Birch Hollow Lane');
  });

  it('renders a not-found state for a 404, distinct from an error', async () => {
    (await awaitPath(fixture, controller, ORDER_URL)).flush(
      { message: 'Not Found' },
      { status: 404, statusText: 'Not Found' },
    );
    (await awaitPath(fixture, controller, PRODUCTS_URL)).flush([]);
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Order not found.');
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('renders an error state with a retry for a failure', async () => {
    (await awaitPath(fixture, controller, ORDER_URL)).flush(
      { message: 'Service unavailable' },
      { status: 503, statusText: 'Service Unavailable' },
    );
    (await awaitPath(fixture, controller, PRODUCTS_URL)).flush([]);
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    expect(textOf(fixture, '[role="alert"]')).toContain('We could not load this order.');

    root.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
    await loadOrder();

    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.textContent).toContain('$143.24');
  });
});
