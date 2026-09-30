import type { Stripe, StripeElements } from '@stripe/stripe-js';

/** Shown when card entry cannot proceed, on either surface. */
export const CARD_ENTRY_UNAVAILABLE =
  'Card entry is unavailable right now. Please try again later.';

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
 * CONTRACT: `mintClientSecret` runs ONLY after Stripe.js resolves and exactly
 * once per mount — every call creates a SetupIntent, so minting on each render
 * abandons one per page view. Not exported: `openCardEntry` wraps it with the
 * error handling a surface must not skip.
 * See [[2026-09-19-stripe-payments-design]]
 */
async function mountPaymentElement(
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

/** A confirmed SetupIntent's payment method, or why there is none. */
export type ConfirmedSetup =
  | { readonly ok: true; readonly paymentMethodId: string }
  | { readonly ok: false; readonly report: Error; readonly message: string };

/**
 * CONTRACT: The confirm path both surfaces share, up to — and NOT including —
 * what each does with the id. The checkout attaches only when the buyer opted
 * in; the profile always attaches and may promote. Those differ legitimately;
 * everything before them did not, and drifted once already.
 *
 * Never returns the raw StripeError: `stripeErrorToError` strips the
 * `payment_method` it carries. See [[browser-rum]]
 */
export async function confirmCardSetup(
  stripe: Stripe,
  elements: StripeElements,
): Promise<ConfirmedSetup> {
  const result = await stripe.confirmSetup({ elements, redirect: 'if_required' });
  if ('error' in result && result.error) {
    return {
      ok: false,
      report: stripeErrorToError(result.error),
      message: result.error.message ?? CARD_ENTRY_UNAVAILABLE,
    };
  }

  const paymentMethodId = confirmedPaymentMethodId(result);
  if (paymentMethodId === null) {
    return {
      ok: false,
      report: new Error('Stripe confirmed a SetupIntent with no payment method'),
      message: CARD_ENTRY_UNAVAILABLE,
    };
  }
  return { ok: true, paymentMethodId };
}

/** The per-component state `openCardEntry` writes its outcome into. */
export interface CardEntrySinks {
  readonly setStripe: (stripe: Stripe) => void;
  readonly setElements: (elements: StripeElements) => void;
  readonly setUnavailable: () => void;
  readonly setError: (message: string) => void;
  readonly report: (error: unknown) => void;
}

/**
 * CONTRACT: Open card entry HERE, when the form opens — not when the selector
 * renders, which abandons a SetupIntent per page view. Both surfaces open it
 * identically; only what they do with the resulting id differs.
 * See [[2026-09-19-stripe-payments-design]]
 */
export async function openCardEntry(
  loadStripe: () => Promise<Stripe | null>,
  mintClientSecret: () => Promise<string>,
  target: HTMLElement,
  sinks: CardEntrySinks,
  describeError: (error: unknown) => string,
): Promise<void> {
  try {
    const mounted = await mountPaymentElement(loadStripe, mintClientSecret, target);
    if (!mounted.ok) {
      sinks.setUnavailable();
      return;
    }
    sinks.setStripe(mounted.stripe);
    sinks.setElements(mounted.elements);
  } catch (error: unknown) {
    sinks.report(error);
    sinks.setUnavailable();
    sinks.setError(describeError(error));
  }
}
