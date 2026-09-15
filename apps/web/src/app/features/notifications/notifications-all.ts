import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';

import { NotificationFilter } from '../../core/api/notifications-api';
import { NotificationsStore } from '../../core/notifications/notifications-store';
import { parseUtcWallClock } from '../../shared/date/format-date';
import { NotificationItem } from '../../shared/ui/notification-item';
import { groupByDay } from './notification-groups';

/** The pills, in frame order. All is the default, unlike the panel's two tabs. */
const FILTERS: readonly { value: NotificationFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'read', label: 'Read' },
];

/**
 * Design: `Notifications — All` (`v7j7HT`) and `Mobile — Notifications All`
 * (`p6PjdF`). ONE component for both: the mobile frame differs only in layout,
 * so a second component would be two copies of the same list.
 *
 * CONTRACT: Three filter pills with All as default — deliberately different from
 * NotificationsPanel's two tabs (Unread / Read). Both are served by `?filter=`.
 * See [[2026-09-10-in-app-notifications-design]]
 */
@Component({
  selector: 'app-notifications-all',
  imports: [NotificationItem],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './notifications-all.html',
})
export class NotificationsAllPage {
  protected readonly store = inject(NotificationsStore);

  protected readonly filters = FILTERS;

  /**
   * CONTRACT: Re-stamped on every load, not captured once at construction. A tab
   * left open across midnight otherwise buckets a fresh arrival against a
   * stale "now", filing this morning's row under YESTERDAY.
   */
  private readonly renderedAt = signal(new Date());

  protected readonly groups = computed(() =>
    groupByDay(this.store.visible(), shiftToUtcWallClock(this.renderedAt())),
  );

  protected readonly subtitle = computed(
    () => `${this.store.unreadCount()} unread · ${this.store.windowTotal()} in the last 90 days`,
  );

  /**
   * CONTRACT: Mark-on-enter, with the arrival highlight preserved. The frame
   * shows unread rows AND a "Mark all as read" button, which reads as a
   * contradiction; the resolution is to send the PATCH here and keep the dots
   * for the visit. Angular can remount this, so the store's capture is
   * idempotent. See [[2026-09-10-in-app-notifications-design]]
   */
  constructor() {
    void this.enter();
    inject(DestroyRef).onDestroy(() => this.store.leaveAllScreen());
  }

  private async enter(): Promise<void> {
    await this.store.load();
    this.renderedAt.set(new Date());
    await this.store.enterAllScreen();
  }

  protected async setFilter(filter: NotificationFilter): Promise<void> {
    await this.store.setFilter(filter);
    this.renderedAt.set(new Date());
  }

  protected markAllRead(): void {
    void this.store.markAllRead();
  }
}

/**
 * CONTRACT: Shift "now" the same way `parseUtcWallClock` shifts each row, so the
 * two are comparable. Bucketing a UTC-shifted timestamp against a raw local now
 * is off by the viewer's offset — six hours in this repo's own TZ, enough to put
 * a morning row under YESTERDAY.
 */
function shiftToUtcWallClock(now: Date): Date {
  return parseUtcWallClock(now.toISOString()) ?? now;
}
