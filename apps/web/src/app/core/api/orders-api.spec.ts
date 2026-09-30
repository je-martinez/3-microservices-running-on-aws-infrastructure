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

  const LINES = [{ productId: 'prd_V1StGXR8Z5', quantity: 2 }];

  it('posts the lines alone when no payment method and no card metadata are given', () => {
    ordersApi.createOrder(LINES).subscribe();

    const request = controller.expectOne('/v1/orders');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ lines: LINES });
    request.flush({ id: 'ord_1' });
  });

  /**
   * CONTRACT: `paymentMethodId` is OMITTED, not sent as null, when the Stripe
   * branch is off — Orders' request contract accepts null, but omitting it keeps
   * the plain-branch body identical to what shipped before Stripe existed.
   */
  it('sends paymentMethodId only when one is supplied', () => {
    ordersApi.createOrder(LINES, { paymentMethodId: 'pm_1' }).subscribe();

    const request = controller.expectOne('/v1/orders');
    expect(request.request.body).toEqual({ lines: LINES, paymentMethodId: 'pm_1' });
    request.flush({ id: 'ord_1' });
  });

  /**
   * CONTRACT: The card metadata carries brand/last4/expiry ONLY. The PAN and the
   * CVC never leave the browser — a body carrying either turns this repo into a
   * PCI-scope system. See [[2026-09-19-stripe-payments-design]]
   */
  it('sends the plain-branch card metadata, never the PAN or the CVC', () => {
    ordersApi
      .createOrder(LINES, { card: { brand: 'visa', last4: '4242', expMonth: 9, expYear: 2028 } })
      .subscribe();

    const request = controller.expectOne('/v1/orders');
    expect(request.request.body).toEqual({
      lines: LINES,
      card: { brand: 'visa', last4: '4242', expMonth: 9, expYear: 2028 },
    });
    const serialized = JSON.stringify(request.request.body);
    expect(serialized).not.toContain('4242424242424242');
    expect(serialized).not.toContain('cvc');
    request.flush({ id: 'ord_1' });
  });

  /**
   * CONTRACT: The key rides a HEADER, never a body field — Orders reads
   * `Idempotency-Key` off the request headers, so a body key is ignored and two
   * retries of the same attempt create two orders.
   */
  it('sends the idempotency key as a request header', () => {
    ordersApi.createOrder(LINES, { idempotencyKey: 'a-b-c' }).subscribe();

    const request = controller.expectOne('/v1/orders');
    expect(request.request.headers.get('Idempotency-Key')).toBe('a-b-c');
    expect(request.request.body).toEqual({ lines: LINES });
    request.flush({ id: 'ord_1' });
  });

  it('sends no Idempotency-Key header when none is supplied', () => {
    ordersApi.createOrder(LINES).subscribe();

    const request = controller.expectOne('/v1/orders');
    expect(request.request.headers.has('Idempotency-Key')).toBe(false);
    request.flush({ id: 'ord_1' });
  });

  it('carries exactly one /v1 prefix', () => {
    ordersApi.listMyOrders().subscribe();

    const request = controller.expectOne((r) => r.url.startsWith('/v1/'));
    expect(request.request.url).not.toContain('/v1/v1/');
    request.flush([]);
  });
});
