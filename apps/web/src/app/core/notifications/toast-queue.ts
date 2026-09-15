import { Injectable, signal } from '@angular/core';

import { AppNotification } from '../api/types';

/**
 * CONTRACT: ONE constant for the dismiss timer AND the progress bar's animation
 * duration. Two independent values drift, and the bar then lies about how long
 * is left — the bar IS the visible timer, which is the whole reason it exists.
 *
 * WHY 7000: a 3-5 word title plus a 10-14 word body is about 4 seconds of
 * reading, plus the time to notice something appeared in a corner.
 * Accessibility guidance floors auto-dismissal around 5s and toast guidance for
 * a message carrying an action spans 4-10s; 7s sits inside that band with
 * margin. See [[2026-09-10-in-app-notifications-design]]
 */
export const TOAST_DISMISS_MS = 7000;

/**
 * CONTRACT: A hard bound on what WAITS behind the showing toast. Several status
 * transitions in a row must not trap the reader behind a backlog minutes long,
 * so the oldest waiting toast is dropped rather than the newest refused — the
 * newest carries the current state of the order.
 */
const MAX_QUEUED = 3;

/**
 * The single toast slot, its timer, and the bounded queue behind it.
 *
 * CONTRACT: Dismissing a toast does NOT mark its notification read. The unread
 * dot and the badge belong to NotificationsStore; a queue that marked on
 * dismiss would silently clear the inbox of everything that flashed past.
 * See [[2026-09-10-in-app-notifications-design]]
 */
@Injectable({ providedIn: 'root' })
export class ToastQueue {
  private readonly showing = signal<AppNotification | null>(null);
  private pending: AppNotification[] = [];

  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Milliseconds left on the showing toast; the full window until it starts. */
  private remaining = TOAST_DISMISS_MS;
  private startedAt = 0;

  /** The toast on screen, or null when nothing is showing. */
  readonly current = this.showing.asReadonly();

  /**
   * Shows `notification`, or queues it behind the one already showing.
   *
   * CONTRACT: Ignore an id already showing or waiting. A socket reconnect can
   * replay a frame, and the reader would otherwise watch the same toast twice.
   */
  enqueue(notification: AppNotification): void {
    if (this.showing()?.id === notification.id) return;
    if (this.pending.some((queued) => queued.id === notification.id)) return;

    if (this.showing() === null) {
      this.show(notification);
      return;
    }

    this.pending.push(notification);
    if (this.pending.length > MAX_QUEUED) this.pending.shift();
  }

  /** Removes the showing toast by id and promotes whatever waits behind it. */
  dismiss(id: string): void {
    if (this.showing()?.id !== id) return;
    this.next();
  }

  /** Freezes the countdown, banking what is left of it. */
  pause(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.remaining = Math.max(0, this.remaining - (Date.now() - this.startedAt));
  }

  /** Restarts the countdown with the BANKED remainder, not a fresh window. */
  resume(): void {
    if (this.timer !== null || this.showing() === null) return;
    this.arm();
  }

  private show(notification: AppNotification): void {
    this.showing.set(notification);
    this.remaining = TOAST_DISMISS_MS;
    this.arm();
  }

  private arm(): void {
    this.startedAt = Date.now();
    this.timer = setTimeout(() => this.next(), this.remaining);
  }

  private next(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;

    const waiting = this.pending.shift();
    if (waiting === undefined) {
      this.showing.set(null);
      this.remaining = TOAST_DISMISS_MS;
      return;
    }
    this.show(waiting);
  }
}
