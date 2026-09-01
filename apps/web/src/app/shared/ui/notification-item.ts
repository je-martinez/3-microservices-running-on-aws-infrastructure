import { Component, computed, input } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import type { AppNotification } from '../../fixtures/api-types';
import { formatShortDateTime } from '../date/format-date';
import { TrackingStatusIcon } from './tracking-status-icon';

/**
 * Design: frame `Notification Item` (`qwO6X`). One row in `NotificationsPanel`'s
 * list; the Unread/Read frames differ only in this row's background and trailing
 * dot, both driven by `notification().read` rather than two templates.
 *
 * CONTRACT: `AppNotification.status` is nullable — a notification without one
 * falls back to a plain `bell` glyph. `TrackingStatusIcon` requires a non-null
 * `TrackingStatus` and cannot take its place.
 * See [[angular-component-authoring]]
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
