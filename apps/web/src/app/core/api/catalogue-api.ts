import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiClient } from '../http/api-client';
import { Product } from './types';

/**
 * The catalogue surface of services/orders/openapi.yaml.
 *
 * CONTRACT: Paths carry NO "/v1" prefix — APP_CONFIG.apiGatewayUrl supplies it.
 * Writing "/v1/products" here yields a request to "/v1/v1/products", answered by
 * the gateway's own 404 rather than by Orders.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
@Injectable({ providedIn: 'root' })
export class CatalogueApi {
  private readonly api = inject(ApiClient);

  /**
   * GET /products — the active catalogue.
   *
   * CONTRACT: The gateway requires a bearer token here; called outside the
   * authGuard it answers 401, not an empty catalogue.
   * See [[2026-09-04-web-gateway-integration-design]]
   */
  listProducts(): Observable<Product[]> {
    return this.api.get<Product[]>('/products');
  }
}
