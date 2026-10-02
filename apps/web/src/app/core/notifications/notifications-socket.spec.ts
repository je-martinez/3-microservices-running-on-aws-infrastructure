import { TestBed } from '@angular/core/testing';

import { NotificationsSocket } from './notifications-socket';
import { NotificationsStore } from './notifications-store';
import { ToastQueue } from './toast-queue';
import { TokenStore } from '../auth/token-store';
import { APP_CONFIG } from '../config/app-config';

/** A WebSocket stand-in: jsdom's would dial a real address. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static opened: string[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.last = this;
    FakeSocket.opened.push(url);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  receive(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

const WS_URL = 'ws://localhost:4566/ws/abc/$default';

const CREATED_FRAME = {
  type: 'NOTIFICATION_CREATED',
  notification: {
    id: 'ntf_Xd5DbZFucDVRQmYQwXF0yKli',
    type: 'ORDER_STATUS',
    title: 'Order placed',
    body: "260912-RNEKNE · Received and confirmed. We'll email your receipt.",
    metadata: {
      status: 'PLACED',
      order_id: 'ord_UCC',
      order_number: '260912-RNEKNE',
      occurred_at: '2026-09-12T06:13:28.395Z',
    },
    read_at: null,
  },
  unread_count: 2,
};

/** What the events-pipeline pushes down the SAME socket. */
const TRACKING_FRAME = {
  type: 'TRACKING_STATUS_CHANGED',
  order_id: 'ord_UCC',
  status: 'SHIPPED',
};

describe('NotificationsSocket', () => {
  let socket: NotificationsSocket;
  let store: InstanceType<typeof NotificationsStore>;
  let toasts: ToastQueue;

  beforeEach(() => {
    FakeSocket.last = null;
    FakeSocket.opened = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    Object.defineProperty(APP_CONFIG, 'wsUrl', { value: WS_URL, configurable: true });

    TestBed.configureTestingModule({
      providers: [
        {
          provide: TokenStore,
          useValue: {
            read: () =>
              Promise.resolve({ idToken: 'id', accessToken: 'acc·ess', refreshToken: 'ref' }),
          },
        },
      ],
    });
    socket = TestBed.inject(NotificationsSocket);
    store = TestBed.inject(NotificationsStore);
    toasts = TestBed.inject(ToastQueue);
  });

  afterEach(() => {
    socket.disconnect();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  /** CONTRACT: The token rides the query string — no handshake header exists. */
  it('dials the configured url with the access token url-encoded', async () => {
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());

    expect(FakeSocket.opened[0]).toBe(`${WS_URL}?token=acc%C2%B7ess`);
  });

  it('applies a NOTIFICATION_CREATED frame to the store and the toast queue', async () => {
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
    FakeSocket.last?.onopen?.();

    FakeSocket.last?.receive(CREATED_FRAME);

    expect(store.items().map((n) => n.id)).toEqual(['ntf_Xd5DbZFucDVRQmYQwXF0yKli']);
    expect(store.unreadCount()).toBe(2);
    expect(toasts.current()?.id).toBe('ntf_Xd5DbZFucDVRQmYQwXF0yKli');
    expect(socket.status()).toBe('open');
  });

  /**
   * CONTRACT: TRACKING_STATUS_CHANGED shares this socket and belongs to the
   * events-pipeline. Treating every frame as ours maps a tracking payload into
   * a notification whose title and body are undefined.
   * See [[count-only-assertions-hide-cause]]
   */
  it('ignores a frame owned by the events-pipeline', async () => {
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());

    FakeSocket.last?.receive(TRACKING_FRAME);

    expect(store.items()).toHaveLength(0);
    expect(toasts.current()).toBeNull();
  });

  /**
   * CONTRACT: Dispatch on `type`, not on the shape. A future frame carrying its
   * own `notification` key would otherwise be adopted as ours.
   */
  it('ignores a frame of another type even when its shape fits', async () => {
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());

    FakeSocket.last?.receive({ ...CREATED_FRAME, type: 'TRACKING_STATUS_CHANGED' });

    expect(store.items()).toHaveLength(0);
    expect(toasts.current()).toBeNull();
  });

  it('survives a malformed frame rather than throwing into the app', async () => {
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());

    expect(() => FakeSocket.last?.onmessage?.({ data: 'not json' } as MessageEvent)).not.toThrow();
    FakeSocket.last?.receive(CREATED_FRAME);

    expect(store.items()).toHaveLength(1);
  });

  it('opens no socket at all without a token', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: TokenStore, useValue: { read: () => Promise.resolve(null) } }],
    });
    const anonymous = TestBed.inject(NotificationsSocket);

    anonymous.connect();
    await vi.waitFor(() => expect(anonymous.status()).toBe('closed'));

    expect(FakeSocket.opened).toHaveLength(0);
  });

  /**
   * CONTRACT: A sign-out must not reconnect. A retry armed by the close handler
   * would redial with the token it just dropped, in a loop against the
   * authorizer.
   */
  it('does not redial after disconnect', async () => {
    vi.useFakeTimers();
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());

    socket.disconnect();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(FakeSocket.opened).toHaveLength(1);
    vi.useRealTimers();
  });

  it('redials with a backoff that doubles and stops at the cap', async () => {
    vi.useFakeTimers();
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(1));

    FakeSocket.last?.close();
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.opened).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.opened).toHaveLength(2);

    FakeSocket.last?.close();
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeSocket.opened).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.opened).toHaveLength(3);
    vi.useRealTimers();
  });
  /**
   * CONTRACT: `connecting` is the first attempt only. A redial after a dropped
   * connection must read as `reconnecting`, or a user whose updates went stale is
   * told the session is still being set up.
   */
  it('reports connecting first, live once open, then reconnecting after a drop', async () => {
    vi.useFakeTimers();
    expect(socket.liveState()).toBe('connecting');

    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
    expect(socket.liveState()).toBe('connecting');

    FakeSocket.last?.onopen?.();
    expect(socket.liveState()).toBe('live');

    FakeSocket.last?.close();
    expect(socket.liveState()).toBe('reconnecting');
    vi.useRealTimers();
  });

  /** The badge's countdown reads this; a drop must publish when the retry fires. */
  it('publishes the armed retry deadline and clears it once it fires', async () => {
    vi.useFakeTimers();
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(1));
    FakeSocket.last?.onopen?.();
    expect(socket.nextRetryAt()).toBeNull();

    const before = Date.now();
    FakeSocket.last?.close();
    expect(socket.nextRetryAt()).toBe(before + 1000);

    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.nextRetryAt()).toBeNull();
    expect(FakeSocket.opened).toHaveLength(2);
    vi.useRealTimers();
  });

  /**
   * CONTRACT: A deliberate close is `offline`, not `reconnecting` — no retry is
   * armed, so promising one would be a lie the badge keeps telling.
   */
  it('reads a sign-out as offline rather than reconnecting', async () => {
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
    FakeSocket.last?.onopen?.();

    socket.disconnect();

    expect(socket.liveState()).toBe('offline');
    expect(socket.nextRetryAt()).toBeNull();
  });

  it('retryNow dials immediately and resets the backoff it skipped', async () => {
    vi.useFakeTimers();
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(1));
    FakeSocket.last?.onopen?.();

    FakeSocket.last?.close();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(2));
    FakeSocket.last?.close();
    expect(socket.nextRetryAt()).toBe(Date.now() + 2000);

    socket.retryNow();
    await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(3));
    expect(socket.nextRetryAt()).toBeNull();

    // The skipped 2s interval is gone: the next failure waits the base delay.
    FakeSocket.last?.close();
    expect(socket.nextRetryAt()).toBe(Date.now() + 1000);
    vi.useRealTimers();
  });

  /** CONTRACT: A signed-out tab stays closed, whatever the badge asks for. */
  it('retryNow does nothing after a disconnect', async () => {
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(1));
    socket.disconnect();

    socket.retryNow();

    expect(FakeSocket.opened).toHaveLength(1);
  });
  /**
   * CONTRACT: A handshake that NEVER completes must stop reading as a first
   * attempt. A CSP that blocks the connection, or a dead gateway, fires close
   * without ever firing open — reporting that as "Connecting…" forever tells
   * the user to wait for something that is not coming.
   */
  it('reports a never-opening socket as reconnecting, not an eternal connecting', async () => {
    vi.useFakeTimers();
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(1));
    expect(socket.liveState()).toBe('connecting');

    // No onopen ever fires: the handshake is refused, as a CSP block does.
    FakeSocket.last?.close();
    expect(socket.liveState()).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(2));
    expect(socket.liveState()).toBe('reconnecting');

    FakeSocket.last?.close();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(3));
    expect(socket.liveState()).toBe('reconnecting');
    vi.useRealTimers();
  });

  /** A fresh sign-in starts over: the next first attempt is `connecting` again. */
  it('reads as connecting again after a disconnect resets the session', async () => {
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(1));
    FakeSocket.last?.close();
    expect(socket.liveState()).toBe('reconnecting');

    socket.disconnect();
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(2));

    expect(socket.liveState()).toBe('connecting');
  });
  /**
   * CONTRACT: `error` alone must arm the retry. A socket refused by
   * Content-Security-Policy is constructed already CLOSED — it fires `error`,
   * never `close`, and `close()` on it does nothing. Waiting for `close` leaves
   * it dead with no retry, stuck on "Connecting…" for the whole session.
   */
  it('retries a socket that only ever fires error', async () => {
    vi.useFakeTimers();
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(1));

    // CSP-style failure: error with no close behind it.
    FakeSocket.last?.onerror?.();

    expect(socket.liveState()).toBe('reconnecting');
    expect(socket.nextRetryAt()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(2));
    vi.useRealTimers();
  });

  /** Both events firing must still schedule exactly ONE retry. */
  it('arms a single retry when error and close both fire', async () => {
    vi.useFakeTimers();
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(1));

    const dead = FakeSocket.last!;
    dead.onerror?.();
    dead.onclose?.();

    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.opened).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeSocket.opened).toHaveLength(2);
    vi.useRealTimers();
  });
  /**
   * CONTRACT: Losing the network does NOT close an established socket —
   * `readyState` stays OPEN and no event fires — so the browser's own signal is
   * what spares a tab from reporting "Live updates on" over a dead connection.
   */
  it('drops the socket when the browser goes offline, and redials when it returns', async () => {
    vi.useFakeTimers();
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(1));
    FakeSocket.last?.onopen?.();
    expect(socket.liveState()).toBe('live');

    globalThis.dispatchEvent(new Event('offline'));
    expect(socket.liveState()).toBe('reconnecting');

    globalThis.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(2));
    vi.useRealTimers();
  });

  /**
   * CONTRACT: Silence is the only evidence available. This channel is
   * server-to-client only, so there is no ping to send — a socket that stops
   * carrying frames is dropped on the deadline instead.
   */
  it('drops a socket that has gone silent', async () => {
    vi.useFakeTimers();
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(1));
    FakeSocket.last?.onopen?.();

    await vi.advanceTimersByTimeAsync(69_000);
    expect(socket.liveState()).toBe('live');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(socket.liveState()).toBe('reconnecting');
    vi.useRealTimers();
  });

  /** Any frame proves the socket still carries, so the deadline restarts. */
  it('keeps a socket that is still receiving', async () => {
    vi.useFakeTimers();
    socket.connect();
    await vi.waitFor(() => expect(FakeSocket.opened).toHaveLength(1));
    FakeSocket.last?.onopen?.();

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      FakeSocket.last?.receive(CREATED_FRAME);
    }

    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.liveState()).toBe('live');
    vi.useRealTimers();
  });
});
