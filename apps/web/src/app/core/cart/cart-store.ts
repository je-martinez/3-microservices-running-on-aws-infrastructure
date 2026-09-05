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
  /** Set while a mutation is in flight, so the UI can disable its steppers. */
  saving: boolean;
  error: string | null;
}

const INITIAL: CartState = { cart: null, loading: false, saving: false, error: null };

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
  withComputed(({ cart }) => ({
    lines: computed<readonly CartLine[]>(() => cart()?.items ?? []),
    /**
     * CONTRACT: Sum the QUANTITIES, not the line count — the header badge is a
     * count of goods, and counting lines shows "1" for a cart holding five of
     * one product. `quantity` is IntLike, so a string would concatenate.
     */
    itemCount: computed(() =>
      (cart()?.items ?? []).reduce((sum, line) => sum + toInt(line.quantity), 0),
    ),
    /**
     * CONTRACT: An empty cart still reports a non-zero `total` — the server
     * always charges shipping, and `total = subtotal + tax + shipping` holds
     * with no exceptions. Presenting that as money owed bills a buyer for an
     * empty basket, so the UI branches on this instead of on `total.cents`.
     */
    isEmpty: computed(() => (cart()?.items.length ?? 0) === 0),
    /**
     * CONTRACT: `canCheckout` is a HINT, not a guarantee — another buyer can
     * take the last unit between this read and POST /orders, which then fails.
     * Use it to disable the button, never to assume checkout cannot fail.
     */
    canCheckout: computed(() => cart()?.canCheckout === true),
  })),
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

      /** Sets an absolute quantity; zero or less removes the line. */
      setQuantity: (productId: string, quantity: number): Promise<void> =>
        enqueue(() => write((lines) => withQuantity(lines, productId, quantity))),

      /** Removes a line outright. */
      remove: (productId: string): Promise<void> =>
        enqueue(() => write((lines) => withQuantity(lines, productId, 0))),

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
       */
      forgetAfterCheckout: (): void => patchState(store, { ...INITIAL }),
    };
  }),
);
