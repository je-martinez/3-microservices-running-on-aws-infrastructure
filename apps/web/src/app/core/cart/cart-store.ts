import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { Subject, concatMap, firstValueFrom, from } from 'rxjs';

import { CartApi, CartItemRequest } from '../api/cart-api';
import { Cart, CartLine, toInt } from '../api/types';
import { ApiError } from '../http/api-client';

interface CartState {
  /** The server's cart. Null until the first successful read. */
  cart: Cart | null;
  loading: boolean;
  /** Set while a mutation is in flight, so the UI can skeleton stale money. */
  saving: boolean;
  /**
   * Quantities the buyer has clicked to but the server has not confirmed,
   * keyed by productId. Empty between debounce windows.
   *
   * CONTRACT: This is an OVERLAY on `cart`, never a replacement. An entry is
   * dropped the moment its PUT settles, so the server's answer wins — it can
   * clamp to stock, and a store that kept the optimistic number would show a
   * quantity the buyer cannot actually buy.
   * See [[2026-09-04-web-gateway-integration-design]]
   */
  pendingQuantities: Readonly<Record<string, number>>;
  error: string | null;
}

const INITIAL: CartState = {
  cart: null,
  loading: false,
  saving: false,
  pendingQuantities: {},
  error: null,
};

/**
 * How long the steppers coalesce clicks before writing.
 *
 * WHY: 350ms sits above the ~200ms a deliberate second click takes and below
 * the ~500ms at which the cart feels unresponsive after the last click.
 */
const QUANTITY_DEBOUNCE_MS = 350;

const UNREACHABLE = 'We could not reach your cart. Check your connection and try again.';
const FAILED = 'We could not update your cart. Please try again.';

function messageFor(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 0) return UNREACHABLE;
  // A 500 from the concurrent-create race carries an EMPTY body, so `detail`
  // degrades to the browser's transport string. Prefer our own sentence.
  if (error.status >= 500) return fallback;
  return error.detail;
}

/** The wire lines, reduced to what PUT /cart reads back. */
function toItems(lines: readonly CartLine[]): CartItemRequest[] {
  return lines.map((line) => ({ productId: line.productId, quantity: toInt(line.quantity) }));
}

/**
 * Applies one quantity change to a cart's lines. A quantity of zero or less
 * drops the line, which is how the server deletes one — there is no per-line
 * DELETE, only a whole-cart replace.
 */
function withQuantity(
  lines: readonly CartLine[],
  productId: string,
  quantity: number,
): CartItemRequest[] {
  const items = toItems(lines).filter((item) => item.productId !== productId);
  if (quantity > 0) items.push({ productId, quantity });
  return items;
}

/**
 * The server-backed cart.
 *
 * CONTRACT: Every mutation goes through the `concatMap` queue below, never
 * straight to CartApi. PUT /cart replaces the WHOLE cart, so two in-flight PUTs
 * clobber each other; worse, on a user with no active cart the losing writer
 * answers 500 with an empty body — the one-active-cart unique index rejecting
 * it, unhandled server-side (JE-246). Two fast clicks on add-to-cart from an
 * empty cart is exactly that race.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
export const CartStore = signalStore(
  { providedIn: 'root' },
  withState<CartState>(INITIAL),
  withComputed(({ cart, pendingQuantities }) => {
    /**
     * CONTRACT: Every quantity the UI reads comes from here, not from
     * `cart().items`. The optimistic overlay is what makes the number track the
     * buyer's finger during a debounce window; a template reading the raw cart
     * shows the pre-click quantity until the PUT answers ~350ms later.
     */
    const lines = computed<readonly CartLine[]>(() => {
      const items = cart()?.items ?? [];
      const pending = pendingQuantities();
      if (Object.keys(pending).length === 0) return items;
      return items
        .map((line) =>
          line.productId in pending
            ? { ...line, quantity: pending[line.productId] as CartLine['quantity'] }
            : line,
        )
        .filter((line) => toInt(line.quantity) > 0);
    });

    return {
      lines,
      /**
       * CONTRACT: Sum the QUANTITIES, not the line count — the header badge is a
       * count of goods, and counting lines shows "1" for a cart holding five of
       * one product. `quantity` is IntLike, so a string would concatenate.
       */
      itemCount: computed(() => lines().reduce((sum, line) => sum + toInt(line.quantity), 0)),
      /**
       * CONTRACT: An empty cart still reports a non-zero `total` — the server
       * always charges shipping, and `total = subtotal + tax + shipping` holds
       * with no exceptions. Presenting that as money owed bills a buyer for an
       * empty basket, so the UI branches on this instead of on `total.cents`.
       */
      isEmpty: computed(() => lines().length === 0),
      /**
       * CONTRACT: `canCheckout` is a HINT, not a guarantee — another buyer can
       * take the last unit between this read and POST /orders, which then fails.
       * Use it to disable the button, never to assume checkout cannot fail.
       *
       * CONTRACT: Read the SERVER's cart, never `lines()`. An optimistic
       * quantity is unverified against stock, so deriving buyability from it
       * would enable checkout on a cart the server is about to clamp.
       * See [[2026-09-04-web-gateway-integration-design]]
       */
      canCheckout: computed(() => cart()?.canCheckout === true),
      /** True while a debounced quantity change is armed but not yet written. */
      adjusting: computed(() => Object.keys(pendingQuantities()).length > 0),
    };
  }),
  withMethods((store) => {
    const api = inject(CartApi);

    /**
     * CONTRACT: Every mutation is pushed here and run by the single `concatMap`
     * subscription below. `concatMap` is what serializes: it holds each task
     * until the previous one completes, so N rapid stepper clicks become N
     * SEQUENTIAL PUTs. `mergeMap`/`switchMap` compile identically and reopen
     * the clobbering race, and on an empty cart the losing writer 500s.
     * See [[2026-09-04-web-gateway-integration-design]]
     */
    const queue = new Subject<() => Promise<void>>();
    queue.pipe(concatMap((task) => from(task()))).subscribe();

    /** Runs `task` at the back of the queue and resolves once it has finished. */
    function enqueue(task: () => Promise<void>): Promise<void> {
      return new Promise<void>((resolve) => {
        queue.next(async () => {
          await task();
          resolve();
        });
      });
    }

    /**
     * One armed debounce timer per productId.
     *
     * CONTRACT: Key by PRODUCT, never a single shared timer. A global timer
     * makes a click on product B cancel product A's pending write, so A's
     * quantity silently reverts to whatever the server last confirmed.
     * See [[2026-09-04-web-gateway-integration-design]]
     */
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    /** Drops one product's optimistic overlay, leaving the others armed. */
    function clearPending(productId: string): void {
      const rest = { ...store.pendingQuantities() };
      delete rest[productId];
      patchState(store, { pendingQuantities: rest });
    }

    /**
     * Shows `quantity` immediately and writes it once the clicks stop.
     *
     * CONTRACT: Restarting the timer is what coalesces — five clicks on one
     * line must produce ONE PUT carrying the FINAL quantity, not five sequential
     * round trips the buyer waits out one by one.
     * See [[2026-09-04-web-gateway-integration-design]]
     */
    function debouncedSetQuantity(productId: string, quantity: number): void {
      patchState(store, {
        pendingQuantities: { ...store.pendingQuantities(), [productId]: quantity },
      });

      clearTimeout(timers.get(productId));
      timers.set(
        productId,
        setTimeout(() => {
          timers.delete(productId);
          const target = store.pendingQuantities()[productId];
          if (target === undefined) return;
          // CONTRACT: Drop the overlay only AFTER the write settles. Clearing it
          // when the timer fires re-exposes the server's stale quantity for the
          // whole round trip, which reads as the number snapping back.
          void enqueue(() => write((lines) => withQuantity(lines, productId, target))).finally(() =>
            clearPending(productId),
          );
        }, QUANTITY_DEBOUNCE_MS),
      );
    }

    async function read(): Promise<Cart> {
      const cart = await firstValueFrom(api.getCart());
      patchState(store, { cart, error: null });
      return cart;
    }

    /**
     * Writes `items` and stores the cart the server answers with.
     *
     * CONTRACT: Retry ONCE off a fresh read rather than replaying the same
     * body. Serializing fixes this tab, not a second one — and the retry has to
     * rebuild its items from the server's current lines, or it reinstates
     * whatever the other writer just removed.
     * See [[2026-09-04-web-gateway-integration-design]]
     */
    async function write(
      itemsFrom: (lines: readonly CartLine[]) => CartItemRequest[],
    ): Promise<void> {
      patchState(store, { saving: true, error: null });
      try {
        const items = itemsFrom(store.cart()?.items ?? []);
        patchState(store, { cart: await firstValueFrom(api.replaceCart(items)) });
      } catch {
        try {
          const fresh = await firstValueFrom(api.getCart());
          const retried = itemsFrom(fresh.items);
          patchState(store, { cart: await firstValueFrom(api.replaceCart(retried)) });
        } catch (error: unknown) {
          patchState(store, { error: messageFor(error, FAILED) });
        }
      } finally {
        patchState(store, { saving: false });
      }
    }

    return {
      /** Reads the cart, replacing whatever is held. Safe to call on every open. */
      load: (): Promise<void> =>
        enqueue(async () => {
          patchState(store, { loading: true, error: null });
          try {
            await read();
          } catch (error: unknown) {
            patchState(store, { error: messageFor(error, UNREACHABLE) });
          } finally {
            patchState(store, { loading: false });
          }
        }),

      /** Adds `quantity` more of a product, on top of whatever the cart holds. */
      add: (productId: string, quantity = 1): Promise<void> =>
        enqueue(() =>
          write((lines) => {
            const held = lines.find((line) => line.productId === productId);
            return withQuantity(lines, productId, (held ? toInt(held.quantity) : 0) + quantity);
          }),
        ),

      /** Sets an absolute quantity and writes it now; zero or less removes the line. */
      setQuantity: (productId: string, quantity: number): Promise<void> =>
        enqueue(() => write((lines) => withQuantity(lines, productId, quantity))),

      /**
       * The steppers' entry point: shows `quantity` at once, writes it once the
       * clicks stop.
       *
       * CONTRACT: Use this for +/-, never `setQuantity`. Writing per click makes
       * five taps five sequential PUTs, each one a round trip the buyer waits
       * out with a stale total on screen.
       * See [[2026-09-04-web-gateway-integration-design]]
       */
      adjustQuantity: (productId: string, quantity: number): void =>
        debouncedSetQuantity(productId, quantity),

      /** Removes a line outright. */
      remove: (productId: string): Promise<void> => {
        // A queued debounce for this line would resurrect it after the removal.
        clearTimeout(timers.get(productId));
        timers.delete(productId);
        clearPending(productId);
        return enqueue(() => write((lines) => withQuantity(lines, productId, 0)));
      },

      /** DELETE /cart, then drop what is held. Answers 204 with no body. */
      clear: (): Promise<void> =>
        enqueue(async () => {
          patchState(store, { saving: true, error: null });
          try {
            await firstValueFrom(api.deleteCart());
            patchState(store, { cart: null });
          } catch (error: unknown) {
            patchState(store, { error: messageFor(error, FAILED) });
          } finally {
            patchState(store, { saving: false });
          }
        }),

      /**
       * CONTRACT: Call this after a successful POST /orders. Order creation
       * DELETES the cart server-side, so the lines still held here describe
       * something that no longer exists — a drawer left open would offer to
       * check them out a second time.
       *
       * CONTRACT: Cancel the armed debounce timers too. One left running fires
       * a PUT after the order is placed and recreates the cart the order just
       * consumed, so the buyer returns to a basket they have already paid for.
       * See [[2026-09-04-web-gateway-integration-design]]
       */
      forgetAfterCheckout: (): void => {
        timers.forEach(clearTimeout);
        timers.clear();
        patchState(store, { ...INITIAL });
      },
    };
  }),
);
