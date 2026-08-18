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
  template: `
    <div
      class="border-line bg-surface-white fixed top-[96px] right-6 z-50 flex h-fit w-[400px] max-w-[calc(100vw-2rem)] flex-col items-start justify-start gap-0 overflow-hidden rounded-xl border shadow-[0px_10px_30px_0px_#1A1A2E29]"
    >
      <div class="flex h-fit w-full shrink-0 flex-row items-start justify-start gap-3 p-4">
        @if (notification().status; as status) {
          <app-tracking-status-icon [status]="status" />
        } @else {
          <span
            class="bg-surface-subtle inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          >
            <svg lucideIcon="bell" class="text-ink-secondary h-[18px] w-[18px]"></svg>
          </span>
        }

        <div class="flex h-fit flex-1 flex-col items-start justify-start gap-1">
          <div class="text-ink-muted text-[10.5px] font-semibold tracking-[1.4px] whitespace-nowrap">
            ORDER UPDATE
          </div>
          <div class="text-ink-primary text-[14.5px] font-semibold whitespace-nowrap">
            {{ notification().title }}
          </div>
          <div class="text-ink-secondary w-full text-[13px] leading-[19px]">
            {{ notification().body }}
          </div>
          <div class="flex h-fit w-fit shrink-0 flex-row items-center justify-start gap-4 pt-[6px]">
            <button
              type="button"
              class="text-brand-navy text-[13px] font-semibold whitespace-nowrap"
              (click)="viewOrder.emit()"
            >
              View order
            </button>
            <button
              type="button"
              class="text-ink-secondary text-[13px] whitespace-nowrap"
              (click)="dismissed.emit()"
            >
              Dismiss
            </button>
          </div>
        </div>

        <button
          type="button"
          class="flex h-6 w-6 shrink-0 flex-row items-center justify-center rounded-md"
          (click)="dismissed.emit()"
        >
          <svg lucideX class="text-ink-muted h-[15px] w-[15px]"></svg>
        </button>
      </div>

      <!-- Progress Track / Progress Fill: the design shows this partially
           drained (auto-dismiss countdown). Phase 1 has no timer driving it,
           so it renders full — a host adding a real timer animates the
           fill's width down to 0 over the toast's lifetime. -->
      <div class="bg-line flex h-[3px] w-full shrink-0 flex-row items-start justify-start">
        <div class="bg-brand-orange h-[3px] w-full shrink-0"></div>
      </div>
    </div>
  `,
})
export class ToastNotification {
  readonly notification = input.required<AppNotification>();

  readonly dismissed = output<void>();
  readonly viewOrder = output<void>();
}
