import { Component, computed, input, output, signal, ChangeDetectionStrategy } from '@angular/core';
import { LucideDynamicIcon, LucideX } from '@lucide/angular';
import type { AppNotification } from '../../core/api/types';
import { TOAST_DISMISS_MS } from '../../core/notifications/toast-queue';
import { visualFor } from './notification-icon-map';

/**
 * Design: `Toast Notification` (`jYz4h`), covering the `IQCEF`/`UpmOQ` pair.
 * It owns no visibility or timer state; a host wires `notification` plus
 * `dismissed`/`viewOrder`/`paused`, and places it top-right at `z-50`.
 *
 * CONTRACT: Do NOT make this an `OverlayKind`. It is transient, carries no
 * Scrim, and may appear while the cart is open — folding it into `active` makes
 * showing a toast close the cart.
 * See [[angular-component-authoring]]
 */
@Component({
  selector: 'app-toast-notification',
  imports: [LucideDynamicIcon, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './toast-notification.html',
})
export class ToastNotification {
  readonly notification = input.required<AppNotification>();

  readonly dismissed = output<void>();
  readonly viewOrder = output<void>();

  /** Pauses and resumes the HOST's dismiss timer on hover and focus-within. */
  readonly paused = output<boolean>();

  /**
   * CONTRACT: The bar's duration comes from the SAME constant as the dismiss
   * timer. The bar IS the visible countdown, so two independent values drift and
   * the bar lies about how long is left.
   */
  protected readonly dismissMs = TOAST_DISMISS_MS;

  protected readonly visual = computed(() => visualFor(this.notification()));

  /** Eyebrow and CTA come from `type`; the icon and tint come from `status`. */
  protected readonly eyebrow = computed(() =>
    this.notification().type === 'WELCOME' ? 'WELCOME' : 'ORDER UPDATE',
  );

  protected readonly ctaLabel = computed(() =>
    this.notification().type === 'WELCOME' ? 'View my profile' : 'View order',
  );

  /** Mirrors the emitted pause state so the bar freezes with the host's timer. */
  protected readonly held = signal(false);

  protected hold(paused: boolean): void {
    this.held.set(paused);
    this.paused.emit(paused);
  }
}
