import { Injectable, inject, signal } from '@angular/core';

import { NotificationWire, toNotification } from '../api/notifications-api';
import { TokenStore } from '../auth/token-store';
import { APP_CONFIG } from '../config/app-config';
import { NotificationsStore } from './notifications-store';
import { ToastQueue } from './toast-queue';

export type SocketStatus = 'idle' | 'connecting' | 'open' | 'closed';

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

  readonly status = this.state.asReadonly();

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
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.retryDelay = BASE_RETRY_MS;

    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.state.set('closed');
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

    const socket = new WebSocket(`${url}?token=${encodeURIComponent(tokens.accessToken)}`);
    this.socket = socket;

    socket.onopen = () => {
      this.retryDelay = BASE_RETRY_MS;
      this.state.set('open');
    };
    socket.onmessage = (event: MessageEvent) => this.dispatch(event.data);
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.state.set('closed');
      this.scheduleRetry();
    };
    // WHY: no reconnect here — a failed handshake also fires `close`, and
    // retrying from both handlers doubles the rate on every failure.
    socket.onerror = () => socket.close();
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

  private scheduleRetry(): void {
    if (!this.wanted || this.retry !== null) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(delay * 2, MAX_RETRY_MS);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.open();
    }, delay);
  }
}
