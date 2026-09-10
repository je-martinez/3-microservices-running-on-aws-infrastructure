import { Component, computed, input, ChangeDetectionStrategy } from '@angular/core';
import { LucideChevronRight } from '@lucide/angular';
import { type OrderWithTracking } from '../../core/api/types';
import { formatPlacedLabel } from '../date/format-date';
import { StatusBadge } from './status-badge';

/**
 * Design: `Order Card` (`l6TyrG`) and `Mobile Order Card` (`tWTSZ`) as ONE
 * responsive component (spec D8) — same node structure, `md:` carries the
 * spacing and thumb-size deltas. The thumbnail strip renders one image per line,
 * sized 46 square on mobile and 52 on desktop as in `Orders — List` (`rGwBO`).
 *
 * CONTRACT: `OrderWithTracking.tracking` is nullable, and `StatusBadge` needs a
 * non-null `TrackingStatus` — skip the badge and its chevron for such an order
 * rather than guessing a status the backend never sent.
 * See [[angular-component-authoring]]
 */
@Component({
  selector: 'app-order-card',
  imports: [LucideChevronRight, StatusBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './order-card.html',
})
export class OrderCard {
  readonly entry = input.required<OrderWithTracking>();

  /**
   * WHY: the strip reads the image off the line itself, so it needs no
   * catalogue join — the order carries its own snapshot, and fetching the
   * catalogue here would put a second request behind every row of the list.
   */
  protected readonly lines = computed(() => this.entry().order.lines);

  /**
   * CONTRACT: Render the server's `formatted` verbatim. Summing the lines
   * instead understates this by exactly the shipping — a line carries no
   * shipping, only the order does. See [[money-representation]]
   */
  protected readonly total = computed(() => this.entry().order.total.formatted);

  /** Shared with `OrderDetailPage`; see `shared/date/format-date.ts`. */
  protected readonly placedLabel = computed(() =>
    formatPlacedLabel(this.entry().order.createdAt, this.entry().order.lines.length),
  );
}
