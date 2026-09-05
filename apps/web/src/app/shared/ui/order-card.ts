import { Component, computed, input } from '@angular/core';
import { LucideChevronRight } from '@lucide/angular';
import { type OrderWithTracking } from '../../core/api/types';
import { formatPlacedLabel } from '../date/format-date';
import { StatusBadge } from './status-badge';

/**
 * Design: `Order Card` (`l6TyrG`) and `Mobile Order Card` (`tWTSZ`) as ONE
 * responsive component (spec D8) — same node structure, `md:` carries the
 * spacing and thumb-size deltas. `OrderLineDto` carries only `productId`, so the
 * thumbnail strip renders one token placeholder per line rather than artwork.
 *
 * CONTRACT: `OrderWithTracking.tracking` is nullable, and `StatusBadge` needs a
 * non-null `TrackingStatus` — skip the badge and its chevron for such an order
 * rather than guessing a status the backend never sent.
 * See [[angular-component-authoring]]
 */
@Component({
  selector: 'app-order-card',
  imports: [LucideChevronRight, StatusBadge],
  templateUrl: './order-card.html',
})
export class OrderCard {
  readonly entry = input.required<OrderWithTracking>();

  /**
   * WHY: the strip is one placeholder per line, so it needs no catalogue join.
   * The card never shows a product name or image, and fetching the catalogue
   * here would put a second request behind every row of the orders list.
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
