import { Component, computed, input, ChangeDetectionStrategy } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import type { AppNotification } from '../../core/api/types';
import { formatShortDateTime } from '../date/format-date';
import { visualFor } from './notification-icon-map';

/**
 * Design: frame `Notification Item` (`qwO6X`). One row in `NotificationsPanel`'s
 * list and in the All screen's date groups; the Unread/Read frames differ only
 * in this row's background and trailing dot.
 *
 * CONTRACT: The bubble comes from `visualFor`, NOT from `TrackingStatusIcon`.
 * That component requires a non-null `TrackingStatus`, so a WELCOME row — which
 * carries none — cannot render through it, and an unknown status would throw
 * rather than fall back to a bell.
 * See [[pencil-design-extraction]]
 */
@Component({
  selector: 'app-notification-item',
  imports: [LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './notification-item.html',
})
export class NotificationItem {
  readonly notification = input.required<AppNotification>();

  /**
   * CONTRACT: Keeps the unread dot and background for the visit even once
   * `readAt` is set — the arrival highlight. Client-only: the server has no
   * notion of "read but still highlighted".
   * See [[2026-09-10-in-app-notifications-design]]
   */
  readonly highlighted = input(false);

  protected readonly visual = computed(() => visualFor(this.notification()));

  /** Unread OR still highlighted: `readAt` governs two visual properties. */
  protected readonly showsUnread = computed(
    () => this.notification().readAt === null || this.highlighted(),
  );

  /**
   * CONTRACT: An override, because the All screen formats per DATE GROUP
   * ("12 min ago" / "8:15 am" / "Aug 2 · 10:24 am") while the panel always uses
   * the dated form. Recomputing the group here would need the row to know which
   * bucket it landed in, which only its container does.
   */
  readonly timeLabel = input<string | null>(null);

  /**
   * `Aug 3 · 8:15 am` — the notification frames omit the year, unlike the
   * order timeline's `Aug 2, 2026 · 10:24 am`, hence the separate helper.
   */
  protected readonly time = computed(
    () => this.timeLabel() ?? formatShortDateTime(this.notification().createdAt),
  );
}
