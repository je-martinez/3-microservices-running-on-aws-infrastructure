import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiClient } from '../http/api-client';
import { Cart, IntLike } from './types';

/**
 * The cart surface of services/orders/openapi.yaml.
 *
 * CONTRACT: Paths carry NO "/v1" prefix — APP_CONFIG.apiGatewayUrl supplies it.
 * Writing "/v1/cart" here yields a request to "/v1/v1/cart", answered by the
 * gateway's own 404 rather than by Orders.
 * See [[2026-09-04-web-gateway-integration-design]]
 */

/** One line of an UpdateCartRequest — the only two fields the server reads. */
export interface CartItemRequest {
  productId: string;
  quantity: IntLike;
}

@Injectable({ providedIn: 'root' })
export class CartApi {
  private readonly api = inject(ApiClient);

  /**
   * GET /cart — the caller's active cart, fully priced.
   *
   * CONTRACT: A user with no cart gets 200 with `id: null` and `items: []`, not
   * a 404. Treating a missing cart as an error path leaves a first-time buyer
   * looking at an error screen instead of an empty cart.
   * See [[2026-09-04-web-gateway-integration-design]]
   */
  getCart(): Observable<Cart> {
    return this.api.get<Cart>('/cart');
  }

  /**
   * PUT /cart — REPLACES every line; an empty `items` deletes the cart.
   *
   * CONTRACT: Two in-flight PUTs clobber each other, and on a user with no
   * active cart yet the losing writer answers 500 with an empty body (the
   * server's one-active-cart unique index, unhandled — JE-246). Callers go
   * through CartStore, which serializes; do NOT call this directly from a
   * component. See [[2026-09-04-web-gateway-integration-design]]
   */
  replaceCart(items: readonly CartItemRequest[]): Observable<Cart> {
    return this.api.put<Cart>('/cart', { items });
  }

  /**
   * DELETE /cart — 204 with NO body. Typed `void` because parsing a response
   * that carries no JSON fails on the empty string, not on a null body.
   */
  deleteCart(): Observable<void> {
    return this.api.delete<void>('/cart');
  }
}
