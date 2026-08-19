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
  templateUrl: './notifications-panel.html',
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
