import { Component, computed, input } from '@angular/core';
import type { TrackingStatus } from '../../fixtures/api-types';

/**
 * Design: frame `Status Badge` (l7LGs); states from `Status Badge — States`
 * (UOHCo), whose label reads:
 *   ORDER STATUS — PLACED -> PROCESSING -> SHIPPED -> OUT_FOR_DELIVERY -> DELIVERED
 * Identical to the backend enum in tracking's domain/status.py.
 *
 * Colours read directly from the UOHCo variant sheet (Get('UOHCo') via the
 * Pencil MCP, not guessed from the export): each state pairs a distinct
 * background/dot/label token — SHIPPED and OUT_FOR_DELIVERY are NOT the same
 * colour, unlike a plausible-looking info/warn split would suggest.
 */
@Component({
  selector: 'app-status-badge',
  template: `
    <span
      class="inline-flex h-[28px] items-center gap-[7px] rounded-full px-[11px]"
      [class]="palette().bg"
    >
      <span class="h-[7px] w-[7px] rounded-full" [class]="palette().dot"></span>
      <span class="text-[12.5px] font-semibold" [class]="palette().text">{{ label() }}</span>
    </span>
  `,
})
export class StatusBadge {
  readonly status = input.required<TrackingStatus>();

  /** Token utilities only — never an arbitrary hex (spec D6). */
  protected readonly palette = computed(() => {
    switch (this.status()) {
      case 'PLACED':
        return { bg: 'bg-surface-subtle', dot: 'bg-ink-secondary', text: 'text-ink-secondary' };
      case 'PROCESSING':
        return { bg: 'bg-warn-bg', dot: 'bg-warn-ink', text: 'text-warn-ink' };
      case 'SHIPPED':
        return { bg: 'bg-info-bg', dot: 'bg-info-blue', text: 'text-info-blue' };
      case 'OUT_FOR_DELIVERY':
        return {
          bg: 'bg-brand-orange-light',
          dot: 'bg-brand-orange-text',
          text: 'text-brand-orange-text',
        };
      case 'DELIVERED':
        return { bg: 'bg-success-bg', dot: 'bg-success-ink', text: 'text-success-ink' };
    }
  });

  protected readonly label = computed(() => {
    const raw = this.status();
    // Title-case each word, matching the design's "Placed" / "Out for delivery" labels.
    return raw
      .toLowerCase()
      .split('_')
      .map((word, i) => (i === 0 ? word[0].toUpperCase() + word.slice(1) : word))
      .join(' ');
  });
}
