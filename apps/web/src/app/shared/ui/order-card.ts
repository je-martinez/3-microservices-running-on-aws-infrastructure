import { Component, computed, input } from '@angular/core';
import { LucideChevronRight } from '@lucide/angular';
import { formatCents, joinOrderLine, type OrderWithTracking } from '../../fixtures/api-types';
import { PRODUCTS } from '../../fixtures/catalogue.fixture';
import { formatPlacedLabel } from '../date/format-date';
import { StatusBadge } from './status-badge';

/**
 * Design: `Order Card` (`l6TyrG`, 1040px) and `Mobile Order Card` (`tWTSZ`,
 * 342px) — ONE responsive component (spec D8), not two: both frames share
 * the same node structure (Order Top / Divider / Order Bottom), differing
 * only in spacing/thumb size, which the `md:` breakpoint carries.
 *
 * `OrderLineDto` carries ONLY `productId` — no name, image or unit price —
 * so a line is joined against the catalogue fixture to render a count and
 * (were the design to need one) a name. In phase 2 this join moves to a
 * selector over real catalogue data; the template does not change.
 *
 * `tracking` is nullable on the wire (`OrderWithTracking.tracking`) — the
 * fixture's `ord_hV2sTaC7wQ` exercises exactly that. `StatusBadge` needs a
 * `TrackingStatus`, which only exists when tracking is non-null, so the
 * badge (and the desktop chevron beside it) is skipped entirely for that
 * order rather than guessing a status.
 */
@Component({
  selector: 'app-order-card',
  imports: [LucideChevronRight, StatusBadge],
  templateUrl: './order-card.html',
})
export class OrderCard {
  readonly entry = input.required<OrderWithTracking>();

  /**
   * Joined for line count/rendering. `product: null` for a delisted product
   * (GET /v1/products returns only the active catalogue) is a real runtime
   * case the join surfaces rather than hides — the thumbnail row below
   * tolerates it because it renders a token placeholder per line regardless
   * of whether the join found a product.
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
