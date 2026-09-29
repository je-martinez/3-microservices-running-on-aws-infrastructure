import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiClient } from '../http/api-client';
import type { PaymentMethodView } from './types';

/**
 * The saved-card surface of services/users/openapi.yaml, one method per route.
 *
 * CONTRACT: Paths carry NO "/v1" prefix — APP_CONFIG.apiGatewayUrl supplies it.
 * "/v1/users/me/payment-methods" here yields "/v1/v1/…", answered by the
 * gateway's own 404. See [[2026-09-04-web-gateway-integration-design]]
 */
/**
 * CONTRACT: Every call goes through ApiClient, never a raw fetch() — a fetch
 * bypasses rumPropagationInterceptor, so the call is absent from app_traces
 * with nothing failing. See [[browser-rum]]
 */

const PAYMENT_METHODS = '/users/me/payment-methods';

/** POST /users/me/payment-methods/setup-intent — SetupIntentResult. */
export interface SetupIntentResult {
  clientSecret: string;
}

/** POST /users/me/payment-methods — AttachPaymentMethodResult. */
export interface AttachPaymentMethodResult {
  id: string;
}

@Injectable({ providedIn: 'root' })
export class PaymentMethodsApi {
  private readonly api = inject(ApiClient);

  /**
   * Mints the client secret the Payment Element mounts against. Each call
   * creates a NEW SetupIntent in Stripe, so it belongs to opening the add-card
   * form, not to rendering the list.
   */
  createSetupIntent(): Observable<SetupIntentResult> {
    return this.api.post<SetupIntentResult>(`${PAYMENT_METHODS}/setup-intent`, {});
  }

  /** GET — reads the local table only; this path never calls Stripe. */
  list(): Observable<PaymentMethodView[]> {
    return this.api.get<PaymentMethodView[]>(PAYMENT_METHODS);
  }

  /**
   * Attaches a confirmed SetupIntent's payment method to the customer, making
   * it a saved card.
   *
   * CONTRACT: Call this ONLY when the buyer asked to save the card. An
   * unchecked "Save this card" means the `pm_...` is used once for this order's
   * PaymentIntent and never attached — attaching anyway writes a row the buyer
   * declined and surfaces the card in every later listing.
   * See [[2026-09-19-stripe-payments-design]]
   */
  attach(paymentMethodId: string): Observable<AttachPaymentMethodResult> {
    return this.api.post<AttachPaymentMethodResult>(PAYMENT_METHODS, { paymentMethodId });
  }

  /** DELETE — 204 with NO body, so `void` rather than a parsed response. */
  remove(id: string): Observable<void> {
    return this.api.delete<void>(`${PAYMENT_METHODS}/${encodeURIComponent(id)}`);
  }

  /** PUT .../default — 204 with no body. */
  setDefault(id: string): Observable<void> {
    return this.api.put<void>(`${PAYMENT_METHODS}/${encodeURIComponent(id)}/default`, {});
  }
}
