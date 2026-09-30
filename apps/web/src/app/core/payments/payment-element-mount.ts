import type { Stripe, StripeElements } from '@stripe/stripe-js';

/**
 * The Payment Element setup shared by the checkout's `New Card Block` and the
 * profile's `Profile — Add Card` — the two surfaces Decision 22 gives the buyer
 * for entering a card. Pure functions over a `Stripe`: no Angular, no HTTP.
 */

/** A mounted Element pair, or the reason there is none to mount against. */
export type PaymentElementMount =
  | { readonly ok: true; readonly stripe: Stripe; readonly elements: StripeElements }
  | { readonly ok: false };

/**
 * CONTRACT: `mintClientSecret` is called ONLY after Stripe.js resolves, and
 * exactly once per mount. Every call creates a new SetupIntent in Stripe, so
 * minting before the load — or on each render — leaves one abandoned intent per
 * page view. See [[2026-09-19-stripe-payments-design]]
 *
 * Throws whatever `loadStripe` or `mintClientSecret` throws; the caller reports
 * it to `ErrorHandler` and renders its own unavailable state.
 */
export async function mountPaymentElement(
  loadStripe: () => Promise<Stripe | null>,
  mintClientSecret: () => Promise<string>,
  target: HTMLElement,
): Promise<PaymentElementMount> {
  const stripe = await loadStripe();
  if (stripe === null) return { ok: false };

  const clientSecret = await mintClientSecret();
  const elements = stripe.elements({ clientSecret });
  // CONTRACT: Turn all three wallets OFF. A wallet is not a payment method to the
  // SetupIntent API — Apple Pay, Google Pay and Link render whenever the intent
  // allows `card`, so restricting the intent server-side does NOT hide them. None
  // is supported here: the saved card must be re-chargeable off-session by Orders,
  // and a wallet hands back a token this integration never attaches.
  // See [[2026-09-19-stripe-payments-design]]
  elements
    .create('payment', {
      wallets: { applePay: 'never', googlePay: 'never', link: 'never' },
      // CONTRACT: Card is the only method this flow accepts, so the buyer must
      // never have to pick it. `defaultCollapsed: false` opens the form on
      // mount, and `radios: 'if_multiple'` drops the selector entirely at one
      // method. Left undefined, Stripe chooses the layout it judges best for
      // conversion, which can collapse a single-method Element behind a row
      // the buyer has to click.
      layout: { type: 'accordion', defaultCollapsed: false, radios: 'if_multiple' },
    })
    .mount(target);
  return { ok: true, stripe, elements };
}

/**
 * CONTRACT: Convert a StripeError into a real Error carrying only its `message`
 * and `type`. The raw object holds a `payment_method` with card details, and
 * `RumErrorHandler` emits `String(error)` for a non-Error value — so passing it
 * through both leaks fields and loses the message. See [[browser-rum]]
 */
export function stripeErrorToError(error: { message?: string; type?: string }): Error {
  const converted = new Error(error.message ?? 'Stripe rejected the card');
  converted.name = `StripeError:${error.type ?? 'unknown'}`;
  return converted;
}

/** The SetupIntent's payment method, which Stripe sends as an id or an object. */
export function confirmedPaymentMethodId(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const intent = (result as { setupIntent?: { payment_method?: unknown } }).setupIntent;
  const method = intent?.payment_method;
  if (typeof method === 'string') return method;
  if (typeof method === 'object' && method !== null) {
    const id = (method as { id?: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}
