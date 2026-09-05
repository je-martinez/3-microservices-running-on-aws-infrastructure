import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { CartStore } from './cart-store';
import { EMPTY_CART, cart, cartLine, unavailableLine } from '../../shared/testing/fixtures';

type Store = InstanceType<typeof CartStore>;

function setup(): { store: Store; controller: HttpTestingController } {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  return { store: TestBed.inject(CartStore), controller: TestBed.inject(HttpTestingController) };
}

/** One macrotask turn — enough for the queue to dispatch its next task. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Pumps until the backend holds at least one `/v1/cart` request of `method`,
 * then returns EVERY one pending at that moment.
 *
 * CONTRACT: Return them all rather than just the first. `match()` consumes what
 * it returns, so a helper taking one would silently discard the concurrent
 * writers a serialisation test exists to detect — the test would then fail two
 * rounds later with "no request", naming starvation instead of the race.
 * See [[2026-09-04-angular-http-testing-traps]]
 */
async function awaitCartRequests(
  controller: HttpTestingController,
  method: string,
): Promise<TestRequest[]> {
  for (let turn = 0; turn < 25; turn += 1) {
    const requests = controller.match((r) => r.url === '/v1/cart' && r.method === method);
    if (requests.length > 0) return requests;
    await tick();
  }
  throw new Error(`No ${method} /v1/cart within 25 turns`);
}

/** The single request expected where no concurrency is under test. */
async function awaitCartRequest(
  controller: HttpTestingController,
  method: string,
): Promise<TestRequest> {
  const [request, ...rest] = await awaitCartRequests(controller, method);
  if (rest.length > 0) throw new Error(`${rest.length + 1} concurrent ${method} /v1/cart`);
  return request;
}

describe('CartStore', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  describe('reading', () => {
    it('holds the cart the server answers with', async () => {
      const { store, controller } = setup();
      const loaded = store.load();

      (await awaitCartRequest(controller, 'GET')).flush(cart([cartLine()]));
      await loaded;

      expect(store.lines()).toHaveLength(1);
      expect(store.loading()).toBe(false);
      expect(store.error()).toBeNull();
      controller.verify();
    });

    /**
     * CONTRACT: `itemCount` sums QUANTITIES, not lines. Counting lines shows "1"
     * for a cart holding five of one product, so the header badge understates
     * what the buyer is carrying.
     */
    it('counts goods rather than lines', async () => {
      const { store, controller } = setup();
      const loaded = store.load();

      (await awaitCartRequest(controller, 'GET')).flush(
        cart([cartLine({ quantity: 4 }), cartLine({ productId: 'prd_other', quantity: 3 })]),
      );
      await loaded;

      expect(store.itemCount()).toBe(7);
      controller.verify();
    });

    /**
     * CONTRACT: An empty cart still reports a non-zero total, because shipping
     * is charged regardless. `isEmpty` must read the items, not the money — a
     * store deriving emptiness from `total.cents` never reports an empty cart.
     */
    it('reports an empty cart as empty despite its non-zero total', async () => {
      const { store, controller } = setup();
      const loaded = store.load();

      (await awaitCartRequest(controller, 'GET')).flush(EMPTY_CART);
      await loaded;

      expect(store.isEmpty()).toBe(true);
      expect(store.canCheckout()).toBe(false);
      expect(Number(store.cart()?.total.cents)).toBeGreaterThan(0);
      controller.verify();
    });

    it('surfaces a failed read as an error rather than an empty cart', async () => {
      const { store, controller } = setup();
      const loaded = store.load();

      (await awaitCartRequest(controller, 'GET')).flush(
        { message: 'nope' },
        { status: 503, statusText: 'Service Unavailable' },
      );
      await loaded;

      expect(store.error()).toBeTruthy();
      expect(store.loading()).toBe(false);
      controller.verify();
    });
  });

  describe('mutations are serialized', () => {
    /**
     * CONTRACT: This is the whole point of the store's queue. PUT /cart replaces
     * the WHOLE cart, so overlapping writes clobber each other — and on a user
     * with no active cart the losing writer answers 500 with an empty body, the
     * one-active-cart index rejecting it (JE-246).
     *
     * The assertion is on the ORDER and COUNT of the requests, not on the final
     * state: a parallel implementation reaches the same final cart and would
     * pass a final-state assertion while shipping the race.
     * See [[2026-09-04-web-gateway-integration-design]]
     */
    it('issues N rapid changes as N sequential, non-overlapping PUTs', async () => {
      const { store, controller } = setup();
      const loaded = store.load();
      (await awaitCartRequest(controller, 'GET')).flush(cart([cartLine({ quantity: 1 })]));
      await loaded;

      // Fired without awaiting, the way four fast stepper clicks arrive.
      const changes = [
        store.setQuantity('prd_V1StGXR8Z5', 2),
        store.setQuantity('prd_V1StGXR8Z5', 3),
        store.setQuantity('prd_V1StGXR8Z5', 4),
        store.setQuantity('prd_V1StGXR8Z5', 5),
      ];

      const quantities: number[] = [];
      for (let round = 0; round < 4; round += 1) {
        const inFlight = await awaitCartRequests(controller, 'PUT');
        // Asserted INSIDE the loop, before flushing. A count checked only at the
        // end never runs: four parallel PUTs all land in round 1, and the next
        // round then starves and reports "no request" instead of the race.
        expect(inFlight).toHaveLength(1);

        const body = inFlight[0].request.body as { items: { quantity: number }[] };
        quantities.push(body.items[0].quantity);
        inFlight[0].flush(cart([cartLine({ quantity: body.items[0].quantity })]));
      }
      await Promise.all(changes);

      expect(quantities).toEqual([2, 3, 4, 5]);
      controller.verify();
    });

    /**
     * The creation race, exactly: two add-to-cart clicks from an empty cart.
     * Concurrently these are the PUTs the server rejects with a 500.
     */
    it('serializes two adds fired from an empty cart', async () => {
      const { store, controller } = setup();
      const loaded = store.load();
      (await awaitCartRequest(controller, 'GET')).flush(EMPTY_CART);
      await loaded;

      const adds = [store.add('prd_V1StGXR8Z5'), store.add('prd_V1StGXR8Z5')];

      // One PUT, not two: the second add waits for the cart to exist.
      const inFlight = await awaitCartRequests(controller, 'PUT');
      expect(inFlight).toHaveLength(1);
      const first = inFlight[0];
      expect(first.request.body).toEqual({ items: [{ productId: 'prd_V1StGXR8Z5', quantity: 1 }] });
      first.flush(cart([cartLine({ quantity: 1 })]));

      const second = await awaitCartRequest(controller, 'PUT');
      // The second add builds on the FIRST one's result, not on the stale cart.
      expect(second.request.body).toEqual({ items: [{ productId: 'prd_V1StGXR8Z5', quantity: 2 }] });
      second.flush(cart([cartLine({ quantity: 2 })]));

      await Promise.all(adds);
      controller.verify();
    });
  });

  describe('mutating', () => {
    it('removes a line by omitting it from the replacement items', async () => {
      const { store, controller } = setup();
      const loaded = store.load();
      (await awaitCartRequest(controller, 'GET')).flush(
        cart([cartLine(), cartLine({ productId: 'prd_other' })]),
      );
      await loaded;

      const removed = store.remove('prd_V1StGXR8Z5');
      const request = await awaitCartRequest(controller, 'PUT');
      expect(request.request.body).toEqual({ items: [{ productId: 'prd_other', quantity: 2 }] });
      request.flush(cart([cartLine({ productId: 'prd_other' })]));
      await removed;

      controller.verify();
    });

    /** A quantity of zero is how the server is told to drop a line. */
    it('drops a line when its quantity reaches zero', async () => {
      const { store, controller } = setup();
      const loaded = store.load();
      (await awaitCartRequest(controller, 'GET')).flush(cart([cartLine({ quantity: 1 })]));
      await loaded;

      const changed = store.setQuantity('prd_V1StGXR8Z5', 0);
      const request = await awaitCartRequest(controller, 'PUT');
      expect(request.request.body).toEqual({ items: [] });
      request.flush(EMPTY_CART);
      await changed;

      controller.verify();
    });

    /**
     * CONTRACT: The retry re-reads first and rebuilds its items from the
     * server's CURRENT lines. Replaying the same body would reinstate whatever
     * a second tab just removed.
     */
    it('re-reads and retries once when a PUT fails', async () => {
      const { store, controller } = setup();
      const loaded = store.load();
      (await awaitCartRequest(controller, 'GET')).flush(cart([cartLine({ quantity: 1 })]));
      await loaded;

      const changed = store.setQuantity('prd_V1StGXR8Z5', 2);

      // The 500 the concurrent-create race produces: empty body, no detail.
      (await awaitCartRequest(controller, 'PUT')).flush(null, {
        status: 500,
        statusText: 'Internal Server Error',
      });

      // The retry re-reads, and the server now also holds another product.
      (await awaitCartRequest(controller, 'GET')).flush(
        cart([cartLine({ quantity: 1 }), cartLine({ productId: 'prd_from_other_tab' })]),
      );

      const retry = await awaitCartRequest(controller, 'PUT');
      expect(retry.request.body).toEqual({
        items: [
          { productId: 'prd_from_other_tab', quantity: 2 },
          { productId: 'prd_V1StGXR8Z5', quantity: 2 },
        ],
      });
      retry.flush(cart([cartLine({ quantity: 2 })]));
      await changed;

      expect(store.error()).toBeNull();
      controller.verify();
    });

    it('reports an error when the retry fails too', async () => {
      const { store, controller } = setup();
      const loaded = store.load();
      (await awaitCartRequest(controller, 'GET')).flush(cart([cartLine({ quantity: 1 })]));
      await loaded;

      const changed = store.setQuantity('prd_V1StGXR8Z5', 2);
      (await awaitCartRequest(controller, 'PUT')).flush(null, { status: 500, statusText: 'Error' });
      (await awaitCartRequest(controller, 'GET')).flush(cart([cartLine({ quantity: 1 })]));
      (await awaitCartRequest(controller, 'PUT')).flush(null, { status: 500, statusText: 'Error' });
      await changed;

      expect(store.error()).toBeTruthy();
      expect(store.saving()).toBe(false);
      controller.verify();
    });

    it('deletes the cart with DELETE and its empty 204 body', async () => {
      const { store, controller } = setup();
      const loaded = store.load();
      (await awaitCartRequest(controller, 'GET')).flush(cart([cartLine()]));
      await loaded;

      const cleared = store.clear();
      (await awaitCartRequest(controller, 'DELETE')).flush(null, {
        status: 204,
        statusText: 'No Content',
      });
      await cleared;

      expect(store.isEmpty()).toBe(true);
      expect(store.cart()).toBeNull();
      controller.verify();
    });
  });

  /**
   * CONTRACT: POST /orders DELETES the cart server-side, so the store drops its
   * lines locally rather than re-reading. A store that kept them would offer to
   * check out a cart that no longer exists.
   */
  it('forgets the cart after checkout without another request', async () => {
    const { store, controller } = setup();
    const loaded = store.load();
    (await awaitCartRequest(controller, 'GET')).flush(cart([cartLine()]));
    await loaded;

    store.forgetAfterCheckout();

    expect(store.cart()).toBeNull();
    expect(store.itemCount()).toBe(0);
    controller.verify();
  });

  /**
   * CONTRACT: `canCheckout` mirrors the server's hint and nothing more. It is
   * not a guarantee — stock can go between this read and POST /orders.
   */
  it('mirrors the server canCheckout hint', async () => {
    const { store, controller } = setup();
    const loaded = store.load();
    (await awaitCartRequest(controller, 'GET')).flush(
      cart([cartLine(), unavailableLine('insufficient_stock')]),
    );
    await loaded;

    expect(store.canCheckout()).toBe(false);
    expect(store.isEmpty()).toBe(false);
    controller.verify();
  });
});
