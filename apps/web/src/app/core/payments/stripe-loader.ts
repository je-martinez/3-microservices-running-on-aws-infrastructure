import { Injectable } from '@angular/core';
import type { Stripe } from '@stripe/stripe-js';

import { APP_CONFIG } from '../config/app-config';

/**
 * The single seam between the app and Stripe.js.
 *
 * CONTRACT: `loadStripe` is reached through a DYNAMIC import. A static import
 * injects the js.stripe.com script tag as a side effect of module evaluation,
 * landing it in the initial bundle, which angular.json's budget rejects.
 * See [[browser-rum]]
 *
 * CONTRACT: Components inject THIS, not `loadStripe` — a spec swaps the whole
 * service, and no test may reach js.stripe.com.
 */
@Injectable({ providedIn: 'root' })
export class StripeLoader {
  private pending: Promise<Stripe | null> | null = null;

  /**
   * Resolves null when no publishable key is configured — the caller then
   * renders its "card entry unavailable" state rather than mounting an Element
   * against an empty key, which Stripe rejects with an opaque error.
   */
  load(): Promise<Stripe | null> {
    const key = APP_CONFIG.stripePublishableKey;
    if (key === null) return Promise.resolve(null);

    // WHY: Memoised because Stripe.js is a singleton on the page — loading it
    // twice re-runs its fraud-signal setup for no benefit.
    this.pending ??= import('@stripe/stripe-js').then(({ loadStripe }) => loadStripe(key));
    return this.pending;
  }
}
