import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  TestRequest,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { NotificationsStore } from './notifications-store';
import { AppNotification } from '../api/types';

type Store = InstanceType<typeof NotificationsStore>;

function setup(): { store: Store; controller: HttpTestingController } {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  return {
    store: TestBed.inject(NotificationsStore),
    controller: TestBed.inject(HttpTestingController),
  };
}

/** One macrotask turn, enough for a pending promise chain to settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Pumps until a request for `url` is pending, then returns it.
 *
 * CONTRACT: Name the url in the failure. A bare "no request" cannot distinguish
 * a store that issued nothing from one that issued the wrong path.
 */
async function awaitRequest(
  controller: HttpTestingController,
  url: string,
  method: string,
): Promise<TestRequest> {
  for (let turn = 0; turn < 25; turn += 1) {
    const requests = controller.match((r) => r.url === url && r.method === method);
    if (requests.length === 1) return requests[0];
    if (requests.length > 1) throw new Error(`${requests.length} concurrent ${method} ${url}`);
    await tick();
  }
  throw new Error(`No ${method} ${url} within 25 turns`);
}

function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ntf_1',
    type: 'ORDER_STATUS',
    title: 'Order placed',
    body: 'Received and confirmed.',
    metadata: { status: 'PLACED', order_id: 'ord_1', occurred_at: '2026-09-12T06:13:28.395Z' },
    read_at: null,
    created_at: '2026-09-12T06:13:28.400Z',
    ...overrides,
  };
}

function page(
  items: Record<string, unknown>[],
  counts: { unread_count?: number; window_total?: number } = {},
): Record<string, unknown> {
  return {
    items,
    unread_count: counts.unread_count ?? items.filter((i) => i['read_at'] === null).length,
    window_total: counts.window_total ?? items.length,
    window_days: 90,
  };
}

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'ntf_new',
    type: 'ORDER_STATUS',
    title: 'Out for delivery',
    body: 'Arriving today.',
    metadata: { status: 'OUT_FOR_DELIVERY', order_id: 'ord_1', occurred_at: '2026-09-12T08:00:00Z' },
    readAt: null,
    createdAt: '2026-09-12T08:00:00Z',
    ...overrides,
  };
}

describe('NotificationsStore', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  describe('loading', () => {
    it('holds the items and both counters the server answers with', async () => {
      const { store, controller } = setup();
      const loaded = store.load();

      (await awaitRequest(controller, '/v1/notifications', 'GET')).flush(
        page([wire()], { unread_count: 1, window_total: 57 }),
      );
      await loaded;

      expect(store.items()).toHaveLength(1);
      expect(store.unreadCount()).toBe(1);
      expect(store.windowTotal()).toBe(57);
      expect(store.loading()).toBe(false);
      expect(store.error()).toBeNull();
      controller.verify();
    });

    it('keeps the held items when a load fails, and surfaces a sentence', async () => {
      const { store, controller } = setup();
      const first = store.load();
      (await awaitRequest(controller, '/v1/notifications', 'GET')).flush(page([wire()]));
      await first;

      const second = store.load();
      (await awaitRequest(controller, '/v1/notifications', 'GET')).flush(
        { error: 'boom' },
        { status: 500, statusText: 'Server Error' },
      );
      await second;

      expect(store.items()).toHaveLength(1);
      expect(store.error()).toBeTruthy();
      expect(store.loading()).toBe(false);
      controller.verify();
    });

    it('re-requests with the filter setFilter selects', async () => {
      const { store, controller } = setup();
      const filtered = store.setFilter('unread');

      const request = await awaitRequest(controller, '/v1/notifications', 'GET');
      expect(request.request.params.get('filter')).toBe('unread');
      request.flush(page([]));
      await filtered;

      expect(store.filter()).toBe('unread');
      controller.verify();
    });

    /**
     * CONTRACT: Filter the held items client-side as well as asking the server.
     * A frame arriving over the socket lands in `items` regardless of the active
     * filter, and the Read tab would otherwise show an unread row until reload.
     */
    it('shows only what the active filter admits', async () => {
      const { store, controller } = setup();
      const loaded = store.load();
      (await awaitRequest(controller, '/v1/notifications', 'GET')).flush(
        page([wire(), wire({ id: 'ntf_2', read_at: '2026-09-12T07:00:00Z' })]),
      );
      await loaded;

      expect(store.visible()).toHaveLength(2);

      const read = store.setFilter('read');
      (await awaitRequest(controller, '/v1/notifications', 'GET')).flush(
        page([wire({ id: 'ntf_2', read_at: '2026-09-12T07:00:00Z' })], { unread_count: 1 }),
      );
      await read;
      expect(store.visible().map((n) => n.id)).toEqual(['ntf_2']);

      store.receive(notification({ id: 'ntf_live' }), 2);
      expect(store.visible().map((n) => n.id)).toEqual(['ntf_2']);
      controller.verify();
    });
  });

  describe('the arrival highlight', () => {
    async function loadedStore(): Promise<{ store: Store; controller: HttpTestingController }> {
      const { store, controller } = setup();
      const loaded = store.load();
      (await awaitRequest(controller, '/v1/notifications', 'GET')).flush(
        page([wire(), wire({ id: 'ntf_2' }), wire({ id: 'ntf_3', read_at: '2026-09-12T07:00:00Z' })]),
      );
      await loaded;
      return { store, controller };
    }

    it('captures the unread ids and marks exactly those read', async () => {
      const { store, controller } = await loadedStore();
      const entered = store.enterAllScreen();

      const request = await awaitRequest(controller, '/v1/notifications/read', 'PATCH');
      expect(request.request.body).toEqual({ ids: ['ntf_1', 'ntf_2'] });
      request.flush({ updated: 2, unread_count: 0 });
      await entered;

      expect(store.unreadCount()).toBe(0);
      controller.verify();
    });

    /**
     * CONTRACT: The dot survives the visit. Dropping it the moment `readAt` is
     * set makes the rows the user came to read blank out under their cursor.
     */
    it('keeps a captured id highlighted after its readAt is set', async () => {
      const { store, controller } = await loadedStore();
      const entered = store.enterAllScreen();
      (await awaitRequest(controller, '/v1/notifications/read', 'PATCH')).flush({
        updated: 2,
        unread_count: 0,
      });
      await entered;

      expect(store.items().find((n) => n.id === 'ntf_1')?.readAt).not.toBeNull();
      expect(store.isHighlighted('ntf_1')).toBe(true);
      expect(store.isHighlighted('ntf_3')).toBe(false);
      controller.verify();
    });

    it('sends no second PATCH when a remount re-enters the screen', async () => {
      const { store, controller } = await loadedStore();
      const entered = store.enterAllScreen();
      (await awaitRequest(controller, '/v1/notifications/read', 'PATCH')).flush({
        updated: 2,
        unread_count: 0,
      });
      await entered;

      await store.enterAllScreen();

      expect(controller.match(() => true)).toHaveLength(0);
      expect(store.isHighlighted('ntf_1')).toBe(true);
      controller.verify();
    });

    /**
     * CONTRACT: A failed PATCH must leave the ids markable. Holding them in the
     * highlight set anyway makes the retry on remount skip them, so rows the
     * user has read stay unread forever with the badge stuck above zero.
     */
    it('retries on remount when the mark-read call failed', async () => {
      const { store, controller } = await loadedStore();
      const entered = store.enterAllScreen();
      (await awaitRequest(controller, '/v1/notifications/read', 'PATCH')).flush(
        { error: 'boom' },
        { status: 500, statusText: 'Server Error' },
      );
      await entered;

      expect(store.error()).toBeTruthy();
      expect(store.isHighlighted('ntf_1')).toBe(false);

      const again = store.enterAllScreen();
      const retry = await awaitRequest(controller, '/v1/notifications/read', 'PATCH');
      expect(retry.request.body).toEqual({ ids: ['ntf_1', 'ntf_2'] });
      retry.flush({ updated: 2, unread_count: 0 });
      await again;

      expect(store.isHighlighted('ntf_1')).toBe(true);
      controller.verify();
    });

    /**
     * CONTRACT: Two entries racing must produce ONE request. Angular remounts
     * synchronously enough that the second call can start before the first
     * PATCH resolves, and a second request would double-count in the UI.
     */
    it('sends one PATCH when a remount re-enters before the first resolves', async () => {
      const { store, controller } = await loadedStore();

      const first = store.enterAllScreen();
      const second = store.enterAllScreen();

      const request = await awaitRequest(controller, '/v1/notifications/read', 'PATCH');
      request.flush({ updated: 2, unread_count: 0 });
      await Promise.all([first, second]);

      expect(controller.match(() => true)).toHaveLength(0);
      expect(store.isHighlighted('ntf_1')).toBe(true);
      controller.verify();
    });

    it('drops the highlight on leaving, so a re-entry renders them read', async () => {
      const { store, controller } = await loadedStore();
      const entered = store.enterAllScreen();
      (await awaitRequest(controller, '/v1/notifications/read', 'PATCH')).flush({
        updated: 2,
        unread_count: 0,
      });
      await entered;

      store.leaveAllScreen();

      expect(store.isHighlighted('ntf_1')).toBe(false);
      controller.verify();
    });
  });

  describe('marking read', () => {
    it('sets readAt locally and takes the server unread count', async () => {
      const { store, controller } = setup();
      const loaded = store.load();
      (await awaitRequest(controller, '/v1/notifications', 'GET')).flush(
        page([wire(), wire({ id: 'ntf_2' })]),
      );
      await loaded;

      const marked = store.markRead(['ntf_1']);
      const request = await awaitRequest(controller, '/v1/notifications/read', 'PATCH');
      expect(request.request.body).toEqual({ ids: ['ntf_1'] });
      request.flush({ updated: 1, unread_count: 1 });
      await marked;

      expect(store.items().find((n) => n.id === 'ntf_1')?.readAt).not.toBeNull();
      expect(store.items().find((n) => n.id === 'ntf_2')?.readAt).toBeNull();
      expect(store.unreadCount()).toBe(1);
      controller.verify();
    });

    it('marks every unread row when asked for all of them', async () => {
      const { store, controller } = setup();
      const loaded = store.load();
      (await awaitRequest(controller, '/v1/notifications', 'GET')).flush(
        page([wire(), wire({ id: 'ntf_2' }), wire({ id: 'ntf_3', read_at: '2026-09-12T07:00:00Z' })]),
      );
      await loaded;

      const marked = store.markAllRead();
      const request = await awaitRequest(controller, '/v1/notifications/read', 'PATCH');
      expect(request.request.body).toEqual({ ids: ['ntf_1', 'ntf_2'] });
      request.flush({ updated: 2, unread_count: 0 });
      await marked;

      expect(store.unreadCount()).toBe(0);
      expect(store.hasUnread()).toBe(false);
      controller.verify();
    });

    /**
     * CONTRACT: Skip the round trip rather than relying on the server's 200 for
     * an empty list — nothing to mark is the ordinary case on every remount.
     */
    it('sends nothing at all for an empty id list', async () => {
      const { store, controller } = setup();

      await store.markRead([]);

      expect(controller.match(() => true)).toHaveLength(0);
      controller.verify();
    });
  });

  describe('receiving a socket frame', () => {
    it('prepends the row and takes the frame unread count', () => {
      const { store, controller } = setup();

      store.receive(notification(), 7);

      expect(store.items().map((n) => n.id)).toEqual(['ntf_new']);
      expect(store.unreadCount()).toBe(7);
      controller.verify();
    });

    /**
     * CONTRACT: A reconnect can replay a frame. Prepending it again would show
     * the same notification twice and a local increment would double the badge.
     */
    it('ignores a duplicate id and still takes the server count', () => {
      const { store, controller } = setup();

      store.receive(notification(), 7);
      store.receive(notification(), 7);

      expect(store.items()).toHaveLength(1);
      expect(store.unreadCount()).toBe(7);
      controller.verify();
    });
  });
});
