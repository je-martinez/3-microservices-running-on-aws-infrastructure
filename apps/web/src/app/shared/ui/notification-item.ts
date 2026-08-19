import { Component, computed, input } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import type { AppNotification } from '../../fixtures/api-types';
import { formatShortDateTime } from '../date/format-date';
import { TrackingStatusIcon } from './tracking-status-icon';

/**
 * Design: frame `Notification Item` (`qwO6X`). One row inside
 * `NotificationsPanel`'s list (spec D8) — the panel's Unread/Read frame pair
 * differs only in this row's background (`bg-surface-subtle` unread vs.
 * transparent read) and whether the trailing dot renders, both driven here
 * by `notification().read`, never by two separate templates.
 *
 * `AppNotification.status` is nullable (see api-types.ts) — a notification
 * with no tracking status (e.g. "Welcome to 3MRAI") falls back to a plain
 * `bell` glyph on a neutral tint rather than reusing `TrackingStatusIcon`,
 * which requires a non-null `TrackingStatus`.
 */
@Component({
  selector: 'app-notification-item',
  imports: [LucideDynamicIcon, TrackingStatusIcon],
  templateUrl: './notification-item.html',
})
export class NotificationItem {
  readonly notification = input.required<AppNotification>();

  /**
   * `Aug 3 · 8:15 am` — the notification frames omit the year, unlike the
   * order timeline's `Aug 2, 2026 · 10:24 am`, hence the separate helper.
   */
  protected readonly timeLabel = computed(() =>
    formatShortDateTime(this.notification().createdAt),
  );
}
