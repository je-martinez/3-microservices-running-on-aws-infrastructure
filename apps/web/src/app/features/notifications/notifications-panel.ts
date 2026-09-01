import { Component, computed, inject, signal } from '@angular/core';
import { OverlayStore } from '../../core/overlay/overlay-store';
import { NOTIFICATIONS } from '../../fixtures/notifications.fixture';
import { NotificationItem } from '../../shared/ui/notification-item';

/**
 * Design: `Notifications Panel` (`LWQ8g`) — ONE component (spec D8) for the
 * Unread (`mSssa`) / Read (`YZIGp`) pair, whose Tabs switch a local `activeTab`
 * signal filtering `NOTIFICATIONS` by each item's `read` flag.
 *
 * CONTRACT: Keep this panel at `z-50`. Its frames carry no Scrim rectangle, so
 * `hasScrim` is false for 'notifications' and nothing else lifts it above
 * anything sitting at `z-40`. See [[angular-component-authoring]]
 */
@Component({
  selector: 'app-notifications-panel',
  imports: [NotificationItem],
  templateUrl: './notifications-panel.html',
})
export class NotificationsPanel {
  protected readonly overlay = inject(OverlayStore);

  protected readonly activeTab = signal<'unread' | 'read'>('unread');

  // Phase 1 has no notifications store — read/unread derives from the fixture.
  protected readonly unread = computed(() => NOTIFICATIONS.filter((n) => !n.read));
  protected readonly read = computed(() => NOTIFICATIONS.filter((n) => n.read));

  protected readonly visibleNotifications = computed(() =>
    this.activeTab() === 'unread' ? this.unread() : this.read(),
  );

  protected markAllRead(): void {
    // No-op in Phase 1: the button matches the design, with no store to persist to.
  }
}
