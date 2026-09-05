import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { OrdersListPage } from './orders-list';
import { settle, textOf } from '../auth/testing';
import { awaitPath, ORDER_WITH_TRACKING, SCREEN_TEST_PROVIDERS } from '../../shared/testing/fixtures';

const MY_ORDERS = '/v1/orders/my-orders';

describe('OrdersListPage', () => {
  let fixture: ComponentFixture<OrdersListPage>;
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
    fixture = TestBed.createComponent(OrdersListPage);
    fixture.detectChanges();
  });

  afterEach(() => {
    controller.verify({ ignoreCancelled: true });
    TestBed.resetTestingModule();
  });

  it('renders a loading state before the orders arrive', () => {
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(root.textContent).toContain('Loading your orders…');
    expect(root.querySelector('app-order-card')).toBeNull();

    controller.expectOne((r) => r.url === MY_ORDERS).flush([]);
  });

  /**
   * CONTRACT: Without `includeTracking=true` the route answers 200 with bare
   * orders and this screen silently renders "No orders yet." — the exact
   * failure this assertion exists to catch. See [[openapi-specs]]
   */
  it('requests the tracking envelope', async () => {
    const request = await awaitPath(fixture, controller, MY_ORDERS);
    expect(request.request.params.get('includeTracking')).toBe('true');
    expect(request.request.urlWithParams).toBe(`${MY_ORDERS}?includeTracking=true`);
    request.flush([]);
    await settle(fixture);
  });

  it('renders a card per order once loaded', async () => {
    (await awaitPath(fixture, controller, MY_ORDERS)).flush([
      ORDER_WITH_TRACKING,
      {
        ...ORDER_WITH_TRACKING,
        order: { ...ORDER_WITH_TRACKING.order, id: 'ord_second' },
        tracking: null,
      },
    ]);
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('app-order-card')).toHaveLength(2);
    expect(root.textContent).toContain('2 orders');
  });

  it("renders each order's own total string verbatim", async () => {
    (await awaitPath(fixture, controller, MY_ORDERS)).flush([ORDER_WITH_TRACKING]);
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    // The order total, NOT the sum of its lines ($138.24) — a line has no shipping.
    expect(root.textContent).toContain('$143.24');
    expect(root.textContent).not.toContain('$138.24');
  });

  it('renders an error state with a retry that refetches', async () => {
    (await awaitPath(fixture, controller, MY_ORDERS)).flush(
      { message: 'Service unavailable' },
      { status: 503, statusText: 'Service Unavailable' },
    );
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    expect(textOf(fixture, '[role="alert"]')).toContain('We could not load your orders.');

    root.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
    (await awaitPath(fixture, controller, MY_ORDERS)).flush([ORDER_WITH_TRACKING]);
    await settle(fixture);

    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelectorAll('app-order-card')).toHaveLength(1);
  });

  it('renders an empty state rather than an error for no orders', async () => {
    (await awaitPath(fixture, controller, MY_ORDERS)).flush([]);
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('No orders yet.');
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });
});
