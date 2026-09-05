import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiClient } from '../http/api-client';
import { OrderWithTracking } from './types';

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

@Injectable({ providedIn: 'root' })
export class OrdersApi {
  private readonly api = inject(ApiClient);

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
