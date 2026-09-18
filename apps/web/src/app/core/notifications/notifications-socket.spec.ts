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
});
