import { Component, computed, input } from '@angular/core';
import type { TrackingStatus } from '../../fixtures/api-types';

/**
 * Design: frame `Status Badge` (l7LGs); states from `Status Badge — States`
 * (UOHCo), matching Tracking's own status list.
 *
 * CONTRACT: Every colour below comes from the UOHCo variant sheet read over the
 * Pencil MCP, never from the HTML export. Each state pairs a distinct
 * background/dot/label token — SHIPPED and OUT_FOR_DELIVERY are different
 * colours, which a plausible info/warn split gets wrong.
 * See [[pencil-design-extraction]]
 */
@Component({
  selector: 'app-status-badge',
  templateUrl: './status-badge.html',
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
