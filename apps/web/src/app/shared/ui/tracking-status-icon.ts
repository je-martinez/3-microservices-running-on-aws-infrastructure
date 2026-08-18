import { Component, computed, input } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import type { TrackingStatus } from '../../fixtures/api-types';

/**
 * Design: frame `Tracking Status Icon` (S59Ud1); states read from the
 * `Tracking Status — Icons` variant sheet (hImQh) via the Pencil MCP — one
 * glyph + tint per tracking state, used in the order timeline, notifications
 * and toast:
 *   PLACED -> receipt-text (bg-line / ink-secondary)
 *   PROCESSING -> package (warn-bg / warn-ink)
 *   SHIPPED -> warehouse (info-bg / info-blue)
 *   OUT_FOR_DELIVERY -> truck (brand-orange-light / brand-orange-text)
 *   DELIVERED -> package-check (success-bg / success-ink)
 * PLACED's cell fill is a literal #E5E7EB in the sheet (not a $token
 * reference) but that hex is exactly the `line` token's value.
 */
@Component({
  selector: 'app-tracking-status-icon',
  imports: [LucideDynamicIcon],
  template: `
    <span
      class="inline-flex h-[36px] w-[36px] items-center justify-center rounded-full"
      [class]="state().bg"
    >
      <svg [lucideIcon]="state().icon" class="text-[18px]" [class]="state().ink"></svg>
    </span>
  `,
})
export class TrackingStatusIcon {
  readonly status = input.required<TrackingStatus>();

  protected readonly state = computed(() => {
    switch (this.status()) {
      case 'PLACED':
        return { icon: 'receipt-text' as const, bg: 'bg-line', ink: 'text-ink-secondary' };
      case 'PROCESSING':
        return { icon: 'package' as const, bg: 'bg-warn-bg', ink: 'text-warn-ink' };
      case 'SHIPPED':
        return { icon: 'warehouse' as const, bg: 'bg-info-bg', ink: 'text-info-blue' };
      case 'OUT_FOR_DELIVERY':
        return {
          icon: 'truck' as const,
          bg: 'bg-brand-orange-light',
          ink: 'text-brand-orange-text',
        };
      case 'DELIVERED':
        return { icon: 'package-check' as const, bg: 'bg-success-bg', ink: 'text-success-ink' };
    }
  });
}
