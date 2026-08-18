import { Component, computed, input } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import type { AppNotification } from '../../fixtures/api-types';
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
  template: `
    <div
      class="flex h-fit w-full shrink-0 flex-row items-center justify-start gap-3 rounded-[10px] p-[14px]"
      [class]="notification().read ? '' : 'bg-surface-subtle'"
    >
      @if (notification().status; as status) {
        <app-tracking-status-icon [status]="status" />
      } @else {
        <span
          class="bg-surface-subtle inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
        >
          <svg lucideIcon="bell" class="text-ink-secondary h-[18px] w-[18px]"></svg>
        </span>
      }

      <div class="flex h-fit flex-1 flex-col items-start justify-start gap-[3px]">
        <div class="text-ink-primary text-[14.5px] font-semibold whitespace-nowrap">
          {{ notification().title }}
        </div>
        <div class="text-ink-secondary w-full text-[13px] leading-[19px]">
          {{ notification().body }}
        </div>
        <div class="text-ink-muted text-xs whitespace-nowrap">{{ timeLabel() }}</div>
      </div>

      @if (!notification().read) {
        <div class="bg-brand-orange h-[9px] w-[9px] shrink-0 rounded-full"></div>
      }
    </div>
  `,
})
export class NotificationItem {
  readonly notification = input.required<AppNotification>();

  protected readonly timeLabel = computed(() => {
    const date = new Date(this.notification().createdAt);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  });
}
