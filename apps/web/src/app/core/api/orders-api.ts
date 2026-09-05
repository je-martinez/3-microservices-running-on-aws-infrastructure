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

@Injectable({ providedIn: 'root' })
export class OrdersApi {
  private readonly api = inject(ApiClient);

  /**
   * POST /orders — creates an order and DELETES the caller's cart server-side.
   *
   * CONTRACT: The server does NOT read the cart; it prices exactly the `lines`
   * sent, and a body of `{}` answers 400. Sending anything but the cart's own
   * lines charges for something the buyer never saw. The caller must drop its
   * local cart afterwards — the cart it still holds no longer exists.
   * See [[2026-09-04-web-gateway-integration-design]]
   */
  createOrder(lines: readonly CreateOrderLine[]): Observable<Order> {
    return this.api.post<Order>('/orders', { lines });
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
