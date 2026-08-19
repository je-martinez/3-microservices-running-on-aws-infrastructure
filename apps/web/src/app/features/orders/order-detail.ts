import { Component, computed, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { LucideArrowLeft } from '@lucide/angular';
import { map } from 'rxjs';
import { AppHeader } from '../../core/layout/app-header';
import { OverlayStore } from '../../core/overlay/overlay-store';
import {
  formatCents,
  joinOrderLine,
  TRACKING_STATUSES,
  type TrackingStatus,
} from '../../fixtures/api-types';
import { PRODUCTS } from '../../fixtures/catalogue.fixture';
import { NOTIFICATIONS } from '../../fixtures/notifications.fixture';
import { ORDERS } from '../../fixtures/orders.fixture';
import { CURRENT_USER } from '../../fixtures/user.fixture';
import { formatDateTime, formatPlacedLabel } from '../../shared/date/format-date';
import { StatusBadge } from '../../shared/ui/status-badge';
import { TrackingStatusIcon } from '../../shared/ui/tracking-status-icon';

/**
 * Design: `Orders — Detail` (`x7ABM`, 1040 desktop / `eq3Tk`, mobile).
 *
 * The tracking timeline renders `TRACKING_STATUSES` in their fixed order
 * (spec: PLACED -> PROCESSING -> SHIPPED -> OUT_FOR_DELIVERY -> DELIVERED),
 * marking a step "reached" when it's present in `tracking.history` — the
 * design's `ord_fB6rEjN4uK` fixture reaches all five; `ord_3kLpQx8vRn`
 * reaches only PLACED. `tracking: null` (the `ord_hV2sTaC7wQ` fixture) skips
 * the whole tracking card rather than rendering an empty timeline.
 *
 * Order lines are joined against the catalogue the same way `OrderCard`
 * does (see its comment on `joinOrderLine`) — `product: null` for a
 * delisted line still renders a row, with a placeholder name.
 */
@Component({
  selector: 'app-order-detail',
  imports: [AppHeader, LucideArrowLeft, StatusBadge, TrackingStatusIcon],
  templateUrl: './order-detail.html',
})
export class OrderDetailPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly overlay = inject(OverlayStore);
  protected readonly hasUnreadNotifications = NOTIFICATIONS.some((n) => !n.read);

  protected readonly formatCents = formatCents;
  /** Timeline rows: `Aug 2, 2026 · 10:24 am` (see shared/date/format-date.ts). */
  protected readonly formatDateTime = formatDateTime;
  protected readonly toInt = (value: Parameters<typeof formatCents>[0]) =>
    typeof value === 'number' ? value : Number.parseInt(value, 10);
  protected readonly trackingStatuses = TRACKING_STATUSES;

  private readonly orderId = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('orderId'))),
    { initialValue: this.route.snapshot.paramMap.get('orderId') },
  );

  protected readonly entry = computed(() => ORDERS.find((o) => o.order.id === this.orderId()) ?? null);

  protected readonly lines = computed(() => {
    const current = this.entry();
    return current ? current.order.lines.map((line) => joinOrderLine(line, PRODUCTS)) : [];
  });

  /**
   * Shared with `OrderCard`, which renders the identical line — the two
   * built this string from separate copies of the same logic before
   * `shared/date/format-date.ts` existed.
   */
  protected readonly placedLabel = computed(() => {
    const current = this.entry();
    if (!current) return '';
    return formatPlacedLabel(current.order.createdAt, current.order.lines.length);
  });

  // NOT from a contract — User.address is untyped on the wire (see
  // api-types.ts's Address comment; the Address interface itself is
  // design-derived). The design's delivery-address card reads the current
  // user's address fixture; Phase 2 must reconcile this once the backend
  // settles on a real shape.
  protected readonly address = CURRENT_USER.address;
  protected readonly userName = CURRENT_USER.fullName;
  protected readonly userPhone = CURRENT_USER.phoneNumber;

  protected historyFor(tracking: NonNullable<ReturnType<typeof this.entry>>['tracking'], status: TrackingStatus) {
    return tracking?.history.find((h) => h.status === status) ?? null;
  }

  protected stepLabel(status: TrackingStatus): string {
    return status
      .toLowerCase()
      .split('_')
      .map((word, i) => (i === 0 ? word[0].toUpperCase() + word.slice(1) : word))
      .join(' ');
  }

  protected goTo(path: string): void {
    void this.router.navigateByUrl(path);
  }
}
