import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { OrdersApi } from './orders-api';

describe('OrdersApi', () => {
  let ordersApi: OrdersApi;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    ordersApi = TestBed.inject(OrdersApi);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify();
    TestBed.resetTestingModule();
  });

  /**
   * CONTRACT: These two assertions are the whole point of this file. Without
   * `includeTracking=true` the routes answer 200 with BARE orders, so every
   * `entry.order` reads undefined and the screens render an empty list on a
   * successful response — a failure no error-path test can catch.
   */
  it('asks my-orders for the tracking envelope', () => {
    ordersApi.listMyOrders().subscribe();

    const request = controller.expectOne(
      (r) => r.url === '/v1/orders/my-orders' && r.params.get('includeTracking') === 'true',
    );
    expect(request.request.method).toBe('GET');
    expect(request.request.urlWithParams).toBe('/v1/orders/my-orders?includeTracking=true');
    request.flush([]);
  });

  it('asks a single order for the tracking envelope', () => {
    ordersApi.getOrder('ord_3kLpQx8vRn').subscribe();

    const request = controller.expectOne(
      (r) => r.url === '/v1/orders/ord_3kLpQx8vRn' && r.params.get('includeTracking') === 'true',
    );
    expect(request.request.method).toBe('GET');
    expect(request.request.urlWithParams).toBe(
      '/v1/orders/ord_3kLpQx8vRn?includeTracking=true',
    );
    request.flush({ order: {}, tracking: null });
  });

  it('escapes an order id rather than pasting it into the path', () => {
    ordersApi.getOrder('ord_a/b').subscribe();

    const request = controller.expectOne((r) => r.url === '/v1/orders/ord_a%2Fb');
    request.flush({ order: {}, tracking: null });
  });

  it('carries exactly one /v1 prefix', () => {
    ordersApi.listMyOrders().subscribe();

    const request = controller.expectOne((r) => r.url.startsWith('/v1/'));
    expect(request.request.url).not.toContain('/v1/v1/');
    request.flush([]);
  });
});
