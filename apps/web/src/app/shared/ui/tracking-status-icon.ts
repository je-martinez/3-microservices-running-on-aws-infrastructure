import { Component, computed, input } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import type { TrackingStatus } from '../../fixtures/api-types';

/**
 * Design: frame `Tracking Status Icon` (S59Ud1) — one glyph and tint per
 * tracking state, used in the order timeline, notifications and toast.
 *
 * CONTRACT: Every glyph and tint below comes from the `Tracking Status — Icons`
 * variant sheet (hImQh) read over the Pencil MCP, not from the export. PLACED's
 * cell is a literal hex in the sheet rather than a $token, and `bg-line` is the
 * token holding that exact value — do not replace it with a nearby grey.
 * See [[pencil-design-extraction]]
 */
@Component({
  selector: 'app-tracking-status-icon',
  imports: [LucideDynamicIcon],
  templateUrl: './tracking-status-icon.html',
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
