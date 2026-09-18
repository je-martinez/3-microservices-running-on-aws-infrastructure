import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { Router } from '@angular/router';

import { NotificationsStore } from '../../core/notifications/notifications-store';
import { OverlayStore } from '../../core/overlay/overlay-store';
import { NotificationItem } from '../../shared/ui/notification-item';

/**
 * Design: `Notifications Panel` (`LWQ8g`) — ONE component (spec D8) for the
 * Unread (`mSssa`) / Read (`YZIGp`) pair, whose Tabs switch a local `activeTab`
 * signal filtering the store's held rows by each item's `readAt`.
 *
 * CONTRACT: Keep this panel at `z-50`. Its frames carry no Scrim rectangle, so
 * `hasScrim` is false for 'notifications' and nothing else lifts it above
 * anything sitting at `z-40`. See [[angular-component-authoring]]
 */

/**
 * CONTRACT: The animation binds on the HOST, not the panel div. Shell removes
 * this component with `@if`, and Angular runs `animate.leave` only on the
 * removed element or a descendant of the SAME template — a binding on the
 * inner div is another template and never fires, leaving the close unanimated.
 *
 * CONTRACT: Do NOT give the host a `transform`; the popover keyframes slide the
 * panel via a `.popover-* > *` rule instead. A transformed host becomes the
 * containing block for this `fixed` panel, and the document grows to reach it —
 * the scrollbar thumb visibly resizes on every open. See [[angular-component-authoring]]
 */
@Component({
  selector: 'app-notifications-panel',
  imports: [NotificationItem],
  templateUrl: './notifications-panel.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'animate.enter': 'popover-enter',
    'animate.leave': 'popover-leave',
  },
})
export class NotificationsPanel {
  protected readonly overlay = inject(OverlayStore);
  protected readonly store = inject(NotificationsStore);
  private readonly router = inject(Router);

  protected readonly activeTab = signal<'unread' | 'read'>('unread');

  /**
   * CONTRACT: Split the HELD rows locally, never re-request per tab. One `filter`
   * serves these two tabs and the All screen's three pills, so a re-requesting
   * tab moves the pill on the other surface.
   * See [[2026-09-10-in-app-notifications-design]]
   */
  protected readonly unread = computed(() =>
    this.store.items().filter((item) => item.readAt === null),
  );
  protected readonly read = computed(() =>
    this.store.items().filter((item) => item.readAt !== null),
  );

  protected readonly visibleNotifications = computed(() =>
    this.activeTab() === 'unread' ? this.unread() : this.read(),
  );

  /** Reads the newest page on every open, so a panel left mounted cannot stale. */
  constructor() {
    void this.store.load('all');
  }

  protected markAllRead(): void {
    void this.store.markAllRead();
  }

  /**
   * CONTRACT: Close the overlay AND navigate. Closing alone leaves the reader on
   * the same page with the panel gone, which reads as the link doing nothing.
   */
  protected viewAll(): void {
    this.overlay.close();
    void this.router.navigateByUrl('/notifications');
  }
}
