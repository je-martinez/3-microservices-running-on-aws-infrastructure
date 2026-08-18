import { Component, computed, inject, signal } from '@angular/core';
import { OverlayStore } from '../../core/overlay/overlay-store';
import { NOTIFICATIONS } from '../../fixtures/notifications.fixture';
import { NotificationItem } from '../../shared/ui/notification-item';

/**
 * Design: `Notifications Panel` (`LWQ8g`), covering the Unread (`mSssa`) /
 * Read (`YZIGp`) frame pair (+ mobile `MP3DR`/`b6S5Bl`) — ONE component
 * (spec D8) whose Tabs switch a local `activeTab` signal, filtering
 * `NOTIFICATIONS` by each item's `read` flag; the two frames differ only in
 * which tab is selected and which subset renders, never in structure.
 *
 * Mounts off `OverlayStore` (in `Shell`, the Task 10/11 seam) ABOVE the
 * Scrim: per DESIGN.md, the notifications frames wrap `Page` + this panel
 * with NO Scrim rectangle, so `hasScrim` stays false for `'notifications'`
 * and this panel alone needs `z-50` to still sit above anything at `z-40`.
 */
@Component({
  selector: 'app-notifications-panel',
  imports: [NotificationItem],
  template: `
    <div
      class="border-line bg-surface-white fixed top-[86px] right-6 z-50 flex h-fit w-[400px] max-w-[calc(100vw-2rem)] flex-col items-start justify-start gap-0 overflow-hidden rounded-xl border shadow-[0px_12px_32px_0px_#1A1A2E29]"
    >
      <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between p-4 pb-3">
        <h2 class="text-ink-primary text-[17px] font-bold tracking-[-0.3px]">Notifications</h2>
        <button type="button" class="text-brand-navy text-[13px] font-semibold" (click)="markAllRead()">
          Mark all as read
        </button>
      </div>

      <div class="border-line flex h-fit w-full shrink-0 flex-row items-end justify-start gap-6 border-b px-4">
        <button
          type="button"
          class="flex h-fit w-fit shrink-0 flex-col items-start justify-start gap-[9px] pb-[9px]"
          (click)="activeTab.set('unread')"
        >
          <span class="flex h-fit w-fit shrink-0 flex-row items-center justify-start gap-[7px]">
            <span
              class="text-[14px] whitespace-nowrap"
              [class]="activeTab() === 'unread' ? 'text-ink-primary font-semibold' : 'text-ink-secondary'"
            >
              Unread
            </span>
            @if (unread().length > 0) {
              <span
                class="bg-brand-orange text-surface-white flex h-5 w-fit shrink-0 flex-row items-center justify-center rounded-full px-[7px] text-[11.5px] font-bold"
              >
                {{ unread().length }}
              </span>
            }
          </span>
          <span
            class="h-[2px] w-full shrink-0 rounded-[1px]"
            [class]="activeTab() === 'unread' ? 'bg-brand-navy' : 'bg-transparent'"
          ></span>
        </button>

        <button
          type="button"
          class="flex h-fit w-fit shrink-0 flex-col items-start justify-start gap-[9px] pb-[9px]"
          (click)="activeTab.set('read')"
        >
          <span
            class="text-[14px] whitespace-nowrap"
            [class]="activeTab() === 'read' ? 'text-ink-primary font-semibold' : 'text-ink-secondary'"
          >
            Read
          </span>
          <span
            class="h-[2px] w-full shrink-0 rounded-[1px]"
            [class]="activeTab() === 'read' ? 'bg-brand-navy' : 'bg-transparent'"
          ></span>
        </button>
      </div>

      <div class="flex h-fit max-h-[420px] w-full shrink-0 flex-col items-start justify-start gap-1 overflow-y-auto p-[10px]">
        @for (notification of visibleNotifications(); track notification.id) {
          <app-notification-item [notification]="notification" />
        } @empty {
          <p class="text-ink-secondary w-full px-1 py-6 text-center text-[13.5px]">
            {{ activeTab() === 'unread' ? "You're all caught up." : 'No read notifications yet.' }}
          </p>
        }
      </div>

      <div class="border-line flex h-fit w-full shrink-0 flex-row items-center justify-center border-t p-[13px]">
        <button type="button" class="text-brand-navy text-[13px] font-semibold" (click)="overlay.close()">
          View all notifications
        </button>
      </div>
    </div>
  `,
})
export class NotificationsPanel {
  protected readonly overlay = inject(OverlayStore);

  protected readonly activeTab = signal<'unread' | 'read'>('unread');

  // Phase 1 has no notifications store — read/unread is derived straight
  // from the fixture. "Mark all as read" has nothing to persist to yet.
  protected readonly unread = computed(() => NOTIFICATIONS.filter((n) => !n.read));
  protected readonly read = computed(() => NOTIFICATIONS.filter((n) => n.read));

  protected readonly visibleNotifications = computed(() =>
    this.activeTab() === 'unread' ? this.unread() : this.read(),
  );

  protected markAllRead(): void {
    // No-op in Phase 1 (see class comment) — the button is present to match
    // the design, not wired to a mutable store.
  }
}
