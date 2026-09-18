import { Component, DestroyRef, inject, ChangeDetectionStrategy } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { CartStore } from '../cart/cart-store';
import { NotificationsSocket } from '../notifications/notifications-socket';
import { NotificationsStore } from '../notifications/notifications-store';
import { ToastQueue } from '../notifications/toast-queue';
import { OverlayStore } from '../overlay/overlay-store';
import { ToastNotification } from '../../shared/ui/toast-notification';
import { AppHeader } from './app-header';

/**
 * CONTRACT: Each routed page keeps its OWN outer wrapper. The backgrounds and
 * heights differ per screen — `/` is `bg-surface-white`, the orders and profile
 * screens are `bg-surface-body` — so hoisting one wrapper up here repaints them.
 * This layout owns only the header and the `min-h-screen` column that lets a
 * page's `flex-1` fill the space below it. See [[angular-component-authoring]]
 */
@Component({
  selector: 'app-app-layout',
  imports: [AppHeader, RouterOutlet, ToastNotification],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-layout.html',
})
export class AppLayout {
  private readonly router = inject(Router);
  protected readonly overlay = inject(OverlayStore);
  protected readonly cart = inject(CartStore);
  protected readonly notifications = inject(NotificationsStore);
  protected readonly toasts = inject(ToastQueue);
  private readonly socket = inject(NotificationsSocket);

  /**
   * CONTRACT: This layout is the ONLY caller of `connect()`, and it sits behind
   * `authGuard` — which is what makes "authenticated boot" the trigger. Opening
   * the socket anywhere shared with the auth layout handshakes with no token and
   * retries against the authorizer from a signed-out tab.
   * See [[2026-09-10-in-app-notifications-design]]
   */
  constructor() {
    this.socket.connect();
    void this.notifications.load();
    inject(DestroyRef).onDestroy(() => this.socket.disconnect());
  }

  /**
   * CONTRACT: The cart opens as an overlay ONLY on `/`. `CartDrawer` mounts in
   * `HomePage` alone, so setting 'cart' from any other route leaves `active`
   * holding a panel nothing renders — the button looks broken and the scrim
   * never appears. Navigating home first is what makes the drawer reachable.
   * See [[angular-component-authoring]]
   */
  protected openCart(): void {
    if (this.router.url.split('?')[0] === '/') {
      this.overlay.openCart();
      return;
    }
    void this.router.navigateByUrl('/');
  }

  /**
   * The toast's CTA. A WELCOME carries no `order_id` — consistent with the
   * envelope, where `order_id` is null for USER_CREATED — so it goes to profile.
   */
  protected openToastTarget(): void {
    const showing = this.toasts.current();
    if (showing === null) return;

    const orderId = showing.metadata.order_id;
    this.toasts.dismiss(showing.id);
    void this.router.navigateByUrl(orderId ? `/orders/${orderId}` : '/profile');
  }

  protected setToastPaused(paused: boolean): void {
    if (paused) this.toasts.pause();
    else this.toasts.resume();
  }
}
