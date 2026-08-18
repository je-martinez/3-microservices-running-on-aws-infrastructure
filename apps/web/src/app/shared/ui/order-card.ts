import { Component, computed, input } from '@angular/core';
import { LucideChevronRight } from '@lucide/angular';
import { formatCents, joinOrderLine, type OrderWithTracking, toInt } from '../../fixtures/api-types';
import { PRODUCTS } from '../../fixtures/catalogue.fixture';
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
  template: `
    <article
      class="border-line bg-surface-white flex h-fit w-full flex-col items-start justify-start gap-[13px] rounded-xl border p-4 md:gap-4 md:p-5"
    >
      <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
        <div class="flex h-fit w-fit shrink-0 flex-col items-start justify-start gap-[3px] md:gap-1">
          <div class="text-ink-primary text-[15px] font-semibold whitespace-nowrap md:text-[15.5px]">
            {{ entry().order.id }}
          </div>
          <div class="text-ink-secondary text-[13px] whitespace-nowrap md:text-[13.5px]">
            {{ placedLabel() }}
          </div>
        </div>

        <!-- Desktop: status badge + total + chevron together on the right. -->
        <div class="hidden h-fit w-fit shrink-0 flex-row items-center justify-start gap-4 md:flex">
          @if (entry().tracking; as tracking) {
            <app-status-badge [status]="tracking.status" />
          }
          <span class="text-ink-primary text-lg font-bold tracking-[-0.3px] whitespace-nowrap">{{
            total()
          }}</span>
          <svg lucideChevronRight class="text-ink-muted h-[18px] w-[18px]"></svg>
        </div>
      </div>

      <!-- Mobile: status badge and total on their own row (no chevron). -->
      <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between md:hidden">
        @if (entry().tracking; as tracking) {
          <app-status-badge [status]="tracking.status" />
        } @else {
          <span></span>
        }
        <span class="text-ink-primary text-lg font-bold tracking-[-0.3px] whitespace-nowrap">{{
          total()
        }}</span>
      </div>

      <div class="bg-line h-px w-full shrink-0"></div>

      <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
        <div class="flex h-fit w-fit shrink-0 flex-row items-center justify-start gap-2">
          @for (line of lines(); track line.productId) {
            <div class="bg-surface-subtle h-[46px] w-[46px] shrink-0 rounded-lg md:h-[52px] md:w-[52px]"></div>
          }
        </div>
        <button
          type="button"
          class="border-line-strong text-brand-navy flex h-9 w-fit shrink-0 flex-row items-center justify-start rounded-lg border px-[14px] text-[13.5px] font-semibold md:h-[38px] md:px-[15px]"
        >
          View details
        </button>
      </div>
    </article>
  `,
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

  protected readonly placedLabel = computed(() => {
    const date = new Date(this.entry().order.createdAt);
    const formatted = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const count = toInt(this.entry().order.lines.length);
    return `Placed ${formatted} · ${count} item${count === 1 ? '' : 's'}`;
  });
}
