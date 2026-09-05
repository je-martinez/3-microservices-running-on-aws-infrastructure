import { Component, input, output } from '@angular/core';
import { LucideDynamicIcon, LucideX } from '@lucide/angular';
import type { AppNotification } from '../../fixtures/api-types';
import { TrackingStatusIcon } from './tracking-status-icon';

/**
 * Design: `Toast Notification` (`jYz4h`), covering the `IQCEF`/`UpmOQ` pair.
 * It owns no visibility or timer state; a host wires `notification` plus
 * `dismissed`/`viewOrder`, and places it top-right at `z-50` per the frame.
 *
 * CONTRACT: Do NOT make this an `OverlayKind`. It is transient, carries no
 * Scrim, and may appear while the cart is open — folding it into `active` makes
 * showing a toast close the cart.
 * See [[angular-component-authoring]]
 */
@Component({
  selector: 'app-toast-notification',
  imports: [LucideDynamicIcon, LucideX, TrackingStatusIcon],
  templateUrl: './toast-notification.html',
})
export class ToastNotification {
  readonly notification = input.required<AppNotification>();

  readonly dismissed = output<void>();
  readonly viewOrder = output<void>();
}
