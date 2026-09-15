import { TestBed } from '@angular/core/testing';

import { TOAST_DISMISS_MS, ToastQueue } from './toast-queue';
import { AppNotification } from '../api/types';

function notification(id: string): AppNotification {
  return {
    id,
    type: 'ORDER_STATUS',
    title: 'Out for delivery',
    body: 'Arriving today.',
    metadata: { status: 'OUT_FOR_DELIVERY', order_id: 'ord_1', occurred_at: '2026-09-12T08:00:00Z' },
    readAt: null,
    createdAt: '2026-09-12T08:00:00Z',
  };
}

describe('ToastQueue', () => {
  let queue: ToastQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({});
    queue = TestBed.inject(ToastQueue);
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('shows the toast and dismisses it at exactly the shared constant', () => {
    queue.enqueue(notification('ntf_1'));
    expect(queue.current()?.id).toBe('ntf_1');

    vi.advanceTimersByTime(TOAST_DISMISS_MS - 1);
    expect(queue.current()?.id).toBe('ntf_1');

    vi.advanceTimersByTime(1);
    expect(queue.current()).toBeNull();
  });

  /**
   * CONTRACT: A toast under the pointer or holding keyboard focus does not
   * expire. Auto-dismissing one the reader is interacting with loses its CTA
   * mid-click.
   */
  it('stops the countdown while paused', () => {
    queue.enqueue(notification('ntf_1'));
    vi.advanceTimersByTime(1000);

    queue.pause();
    vi.advanceTimersByTime(TOAST_DISMISS_MS * 3);

    expect(queue.current()?.id).toBe('ntf_1');
  });

  it('resumes with the remaining time, not a fresh window', () => {
    queue.enqueue(notification('ntf_1'));
    vi.advanceTimersByTime(TOAST_DISMISS_MS - 1000);

    queue.pause();
    vi.advanceTimersByTime(5000);
    queue.resume();

    vi.advanceTimersByTime(999);
    expect(queue.current()?.id).toBe('ntf_1');

    vi.advanceTimersByTime(1);
    expect(queue.current()).toBeNull();
  });

  /**
   * CONTRACT: Dismissing is not reading. The notification keeps `readAt: null`,
   * so its unread dot survives in the panel and the badge does not move.
   */
  it('dismisses immediately without marking the notification read', () => {
    const toast = notification('ntf_1');
    queue.enqueue(toast);

    queue.dismiss('ntf_1');

    expect(queue.current()).toBeNull();
    expect(toast.readAt).toBeNull();
  });

  it('ignores a dismiss naming a toast that is not showing', () => {
    queue.enqueue(notification('ntf_1'));

    queue.dismiss('ntf_other');

    expect(queue.current()?.id).toBe('ntf_1');
  });

  it('shows one at a time and the next only after the current leaves', () => {
    queue.enqueue(notification('ntf_1'));
    queue.enqueue(notification('ntf_2'));

    expect(queue.current()?.id).toBe('ntf_1');

    vi.advanceTimersByTime(TOAST_DISMISS_MS);
    expect(queue.current()?.id).toBe('ntf_2');

    vi.advanceTimersByTime(TOAST_DISMISS_MS);
    expect(queue.current()).toBeNull();
  });

  /**
   * CONTRACT: The queue is BOUNDED. A burst of status transitions must not
   * trap the reader behind a backlog of toasts minutes long.
   */
  it('drops the oldest waiting toast past the bound', () => {
    for (const id of ['ntf_1', 'ntf_2', 'ntf_3', 'ntf_4', 'ntf_5', 'ntf_6']) {
      queue.enqueue(notification(id));
    }

    const shown: string[] = [];
    for (let turn = 0; turn < 6; turn += 1) {
      const current = queue.current();
      if (current) shown.push(current.id);
      vi.advanceTimersByTime(TOAST_DISMISS_MS);
    }

    expect(shown).toEqual(['ntf_1', 'ntf_4', 'ntf_5', 'ntf_6']);
  });

  it('never queues the same notification twice', () => {
    queue.enqueue(notification('ntf_1'));
    queue.enqueue(notification('ntf_1'));

    vi.advanceTimersByTime(TOAST_DISMISS_MS);

    expect(queue.current()).toBeNull();
  });
});
