import { Injectable, computed, inject, signal } from '@angular/core';

import { NotificationWire, toNotification } from '../api/notifications-api';
import { TokenStore } from '../auth/token-store';
import { APP_CONFIG } from '../config/app-config';
import { NotificationsStore } from './notifications-store';
import { ToastQueue } from './toast-queue';

export type SocketStatus = 'idle' | 'connecting' | 'open' | 'closed';

/**
 * What the user is told, which is NOT what the transport reports. `closed`
 * covers two opposite situations — a retry is armed, or nothing is coming — and
 * a badge showing one as the other either hides an outage or invents one.
 * See [[browser-rum]]
 */
export type LiveSessionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** First backoff step; each retry doubles it up to the cap below. */
const BASE_RETRY_MS = 1000;

/**
 * CONTRACT: Cap the backoff. An uncapped doubling stops retrying within an hour
 * of an overnight tab, and an UNCAPPED-DOWN loop against a rejected token is a
 * self-inflicted DoS on the authorizer.
 */
const MAX_RETRY_MS = 30_000;

interface CreatedFrame {
  type: 'NOTIFICATION_CREATED';
  notification: NotificationWire;
  unread_count: number;
}

/**
 * CONTRACT: Validate before dispatching. TRACKING_STATUS_CHANGED shares this
 * socket, and a client assuming every frame is its own maps a tracking payload
 * into a notification with undefined title and body.
 */
function isCreatedFrame(value: unknown): value is CreatedFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Partial<CreatedFrame>;
  return (
    frame.type === 'NOTIFICATION_CREATED' &&
    typeof frame.notification === 'object' &&
    frame.notification !== null &&
    typeof frame.unread_count === 'number'
  );
}

/**
 * The app's only WebSocket. Two message types share it: TRACKING_STATUS_CHANGED
 * from the events-pipeline (live order-detail updates) and NOTIFICATION_CREATED
 * from Users. This client dispatches the latter and ignores the rest, so the
 * pipeline's push stays untouched.
 *
 * CONTRACT: The token rides the QUERY STRING. A WebSocket handshake cannot
 * carry an Authorization header — the only headers reaching the authorizer are
 * the handshake's own.
 * See [[2026-08-05-realtime-tracking-events-websocket-design]]
 */
@Injectable({ providedIn: 'root' })
export class NotificationsSocket {
  private readonly tokens = inject(TokenStore);
  private readonly store = inject(NotificationsStore);
  private readonly toasts = inject(ToastQueue);

  private readonly state = signal<SocketStatus>('idle');
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = BASE_RETRY_MS;
  /** False from `disconnect()` until the next `connect()`, suppressing retries. */
  private wanted = false;
  /**
   * CONTRACT: Counts ATTEMPTS, not successes. A handshake the network never
   * completes — a blocking CSP, a dead gateway — leaves a success flag false
   * forever, and every redial then reads as the first one: an eternal
   * "Connecting…" over a socket that has failed a dozen times.
   */
  private readonly attempts = signal(0);
  private readonly retryAt = signal<number | null>(null);

  readonly status = this.state.asReadonly();

  /** When the armed retry fires, as an epoch ms, or null when none is armed. */
  readonly nextRetryAt = this.retryAt.asReadonly();

  /**
   * CONTRACT: `connecting` is the FIRST attempt only. A redial after a dropped
   * connection is `reconnecting` — telling a user who had live updates that we
   * are "setting up" reads as a fresh page, and hides that they are stale.
   */
  readonly liveState = computed<LiveSessionState>(() => {
    const firstTry = this.attempts() <= 1;
    switch (this.state()) {
      case 'open':
        return 'live';
      case 'connecting':
        return firstTry ? 'connecting' : 'reconnecting';
      case 'closed':
        return this.retryAt() === null ? 'offline' : 'reconnecting';
      default:
        return this.attempts() === 0 ? 'connecting' : 'offline';
    }
  });

  /**
   * Opens the socket, reconnecting until `disconnect()`.
   *
   * CONTRACT: No socket without a token and no URL. The handshake is denied
   * anyway, and retrying it turns a signed-out tab into a retry loop against
   * the authorizer.
   * See [[2026-08-05-realtime-tracking-events-websocket-design]]
   */
  connect(): void {
    if (this.socket !== null || this.state() === 'connecting') return;
    this.wanted = true;
    void this.open();
  }

  /** Closes cleanly and cancels any armed retry, so a sign-out stays signed out. */
  disconnect(): void {
    this.wanted = false;
    this.clearRetry();
    this.retryDelay = BASE_RETRY_MS;
    this.attempts.set(0);

    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.state.set('closed');
  }

  /**
   * Redials now instead of waiting out the backoff, for the badge's "Retry now".
   *
   * CONTRACT: Reset the delay too, or the next failure waits out the old doubled
   * interval the user asked to skip. Stays closed after `disconnect()`.
   */
  retryNow(): void {
    if (!this.wanted || this.socket !== null) return;
    this.clearRetry();
    this.retryDelay = BASE_RETRY_MS;
    void this.open();
  }

  private clearRetry(): void {
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.retryAt.set(null);
  }

  private async open(): Promise<void> {
    const url = APP_CONFIG.wsUrl;
    if (!url) return;

    this.state.set('connecting');
    const tokens = await this.tokens.read();
    // A sign-out racing the token read leaves `wanted` false; honour it.
    if (!this.wanted) return;
    if (tokens === null) {
      this.state.set('closed');
      return;
    }

    this.attempts.update((n) => n + 1);
    const socket = new WebSocket(`${url}?token=${encodeURIComponent(tokens.accessToken)}`);
    this.socket = socket;

    socket.onopen = () => {
      this.retryDelay = BASE_RETRY_MS;
      this.state.set('open');
    };
    socket.onmessage = (event: MessageEvent) => this.dispatch(event.data);
    socket.onclose = () => this.lost(socket);
    /**
     * CONTRACT: `error` arms the retry ITSELF. A socket refused by CSP is born
     * `CLOSED` — it never fires `close`, and `close()` on it is a no-op, so
     * waiting for `close` leaves it dead and stuck on "Connecting…".
     */
    socket.onerror = () => this.lost(socket);
  }

  /**
   * CONTRACT: Swallow a malformed frame. A socket must not throw into the app —
   * an unhandled parse error on a stray payload takes down the message loop and
   * every later notification with it.
   */
  private dispatch(data: unknown): void {
    if (typeof data !== 'string') return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!isCreatedFrame(frame)) return;

    const notification = toNotification(frame.notification);
    this.store.receive(notification, frame.unread_count);
    this.toasts.enqueue(notification);
  }

  /** Drops a dead socket and arms the next attempt, whichever event reported it. */
  private lost(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.state.set('closed');
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (!this.wanted || this.retry !== null) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(delay * 2, MAX_RETRY_MS);
    this.retryAt.set(Date.now() + delay);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.retryAt.set(null);
      void this.open();
    }, delay);
  }
}
