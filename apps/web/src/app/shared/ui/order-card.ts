import { Component, computed, input } from '@angular/core';
import { LucideChevronRight } from '@lucide/angular';
import { formatCents, joinOrderLine, type OrderWithTracking } from '../../fixtures/api-types';
import { PRODUCTS } from '../../fixtures/catalogue.fixture';
import { formatPlacedLabel } from '../date/format-date';
import { StatusBadge } from './status-badge';

/**
 * Design: `Order Card` (`l6TyrG`) and `Mobile Order Card` (`tWTSZ`) as ONE
 * responsive component (spec D8) — same node structure, `md:` carries the
 * spacing and thumb-size deltas. `OrderLineDto` carries only `productId`, so
 * lines are joined against the catalogue to render a count.
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
   * Joined for line count/rendering. `product: null` is a real runtime case:
   * GET /v1/products returns only the active catalogue, so a delisted line finds
   * no match. The thumbnail row renders a token placeholder either way.
   */
  protected readonly lines = computed(() =>
    this.entry().order.lines.map((line) => joinOrderLine(line, PRODUCTS)),
  );

  protected readonly total = computed(() => `$${formatCents(this.entry().order.totalCents)}`);

  /** Shared with `OrderDetailPage`; see `shared/date/format-date.ts`. */
  protected readonly placedLabel = computed(() =>
    formatPlacedLabel(this.entry().order.createdAt, this.entry().order.lines.length),
  );
}
