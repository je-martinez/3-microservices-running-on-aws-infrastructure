import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiClient } from '../http/api-client';
import { IntLike, Order, OrderWithTracking } from './types';

/**
 * The order-reading surface of services/orders/openapi.yaml.
 *
 * CONTRACT: Paths carry NO "/v1" prefix — APP_CONFIG.apiGatewayUrl supplies it.
 * Writing "/v1/orders/my-orders" here yields "/v1/v1/orders/my-orders", answered
 * by the gateway's own 404 rather than by Orders.
 * See [[2026-09-04-web-gateway-integration-design]]
 */

/**
 * CONTRACT: Send `includeTracking=true` on EVERY read below. The parameter
 * defaults to false, and both routes then answer 200 with a bare `Order` where
 * the caller expects an `{order, tracking}` envelope. Nothing throws: every
 * `entry.order` reads undefined, so the list renders as "no orders" and the
 * detail page as "order not found" — a success response that looks like empty
 * data, which no error handler catches. See [[openapi-specs]]
 */
const WITH_TRACKING = { includeTracking: 'true' } as const;

/** One line of a CreateOrderRequest. */
export interface CreateOrderLine {
  productId: string;
  quantity: IntLike;
}

/**
 * services/orders/openapi.yaml — CardMetadataRequest.
 *
 * CONTRACT: brand, last4 and the expiry ONLY. The PAN and the CVC never leave
 * the browser; a body carrying either puts this repo in PCI scope.
 * See [[2026-09-19-stripe-payments-design]]
 */
export interface CardMetadataRequest {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

/**
 * The optional half of a CreateOrderRequest, plus its idempotency header.
 *
 * CONTRACT: `paymentMethodId` and `card` are the route's two BRANCHES and are
 * never both sent — Orders validates `card` only while STRIPE_ENABLED is false.
 * See [[2026-09-19-stripe-payments-design]]
 */
export interface CreateOrderOptions {
  /** Stripe branch: the `pm_...` to charge. */
  paymentMethodId?: string | null;
  /** Plain branch: what the buyer typed, minus the PAN and the CVC. */
  card?: CardMetadataRequest;
  /** One per checkout ATTEMPT, reused only across a retry of that attempt. */
  idempotencyKey?: string;
}

@Injectable({ providedIn: 'root' })
export class OrdersApi {
  private readonly api = inject(ApiClient);

  /**
   * POST /orders — creates an order and DELETES the caller's cart server-side.
   *
   * CONTRACT: The server does NOT read the cart; it prices exactly the `lines`
   * sent, and a body of `{}` answers 400. The caller drops its local cart after.
   * See [[2026-09-04-web-gateway-integration-design]]
   *
   * CONTRACT: `idempotencyKey` rides the `Idempotency-Key` HEADER, where Orders
   * reads it — a body field is ignored, so a retried attempt then creates a
   * second order and a second charge. See [[2026-09-19-stripe-payments-design]]
   */
  createOrder(
    lines: readonly CreateOrderLine[],
    options: CreateOrderOptions = {},
  ): Observable<Order> {
    const { paymentMethodId, card, idempotencyKey } = options;
    return this.api.post<Order>(
      '/orders',
      {
        lines,
        ...(paymentMethodId ? { paymentMethodId } : {}),
        ...(card ? { card } : {}),
      },
      idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : undefined,
    );
  }

  /** GET /orders/my-orders?includeTracking=true — the caller's own orders. */
  listMyOrders(): Observable<OrderWithTracking[]> {
    return this.api.get<OrderWithTracking[]>('/orders/my-orders', { params: WITH_TRACKING });
  }

  /**
   * GET /orders/{orderId}?includeTracking=true.
   * Another user's order answers 404, not 403 — ownership is checked by
   * cognito_sub, and the service declines to confirm the id exists at all.
   */
  getOrder(orderId: string): Observable<OrderWithTracking> {
    return this.api.get<OrderWithTracking>(`/orders/${encodeURIComponent(orderId)}`, {
      params: WITH_TRACKING,
    });
  }
}
