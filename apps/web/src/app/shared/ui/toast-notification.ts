import { Component, input, output } from '@angular/core';
import { LucideDynamicIcon, LucideX } from '@lucide/angular';
import type { AppNotification } from '../../fixtures/api-types';
import { TrackingStatusIcon } from './tracking-status-icon';

/**
 * Design: `Toast Notification` (`jYz4h`), covering the `IQCEF`/`UpmOQ` frame
 * pair. Deliberately NOT an `OverlayKind` — see `OverlayStore`'s comment: it
 * is transient, carries no Scrim, and can appear while the cart or another
 * overlay is open. This component owns no visibility/timer state itself
 * (Phase 1 has no notification stream to trigger it from); a host wires
 * `notification` + `dismissed`/`viewOrder` when it needs one shown.
 *
 * Positioned top-right per the design's `Home — Notification Toast` frame
 * (left: 1016px / top: 96px in a 1440px canvas ≈ flush against the header's
 * right edge) — callers place it as a fixed overlay above everything
 * (`z-50`, matching the other non-cart panels).
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
