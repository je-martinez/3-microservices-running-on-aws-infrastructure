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
  template: `
    <div class="bg-surface-body flex h-fit min-h-screen w-full flex-col items-start justify-start gap-0">
      <app-app-header
        [hasUnreadNotifications]="hasUnreadNotifications"
        (notificationsClicked)="overlay.openNotifications()"
        (profileClicked)="overlay.openAccountMenu()"
        (cartClicked)="goTo('/')"
      />

      @if (entry(); as entry) {
        <div class="flex w-full flex-1 flex-col items-center justify-start gap-0 p-5 md:p-9">
          <div class="flex h-fit w-full max-w-[1040px] shrink-0 flex-col items-start justify-start gap-4 md:gap-[22px]">
            <button
              type="button"
              class="text-ink-secondary flex h-fit w-fit shrink-0 flex-row items-center justify-start gap-[7px]"
              (click)="goTo('/orders')"
            >
              <svg lucideArrowLeft class="h-4 w-4"></svg>
              <span class="text-[13.5px] font-semibold">All orders</span>
            </button>

            <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
              <div class="flex h-fit w-fit shrink-0 flex-col items-start justify-start gap-[3px] md:gap-[6px]">
                <h1 class="text-ink-primary text-xl font-bold tracking-[-0.5px] md:text-[28px] md:tracking-[-0.7px]">
                  {{ entry.order.id }}
                </h1>
                <p class="text-ink-secondary text-[13px] md:text-[14.5px]">{{ placedLabel() }}</p>
              </div>
              @if (entry.tracking; as tracking) {
                <app-status-badge [status]="tracking.status" />
              }
            </div>

            <div class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-5 md:flex-row md:gap-6">
              <div class="flex h-fit w-full min-w-0 flex-1 flex-col items-start justify-start gap-5">
                @if (entry.tracking; as tracking) {
                  <div class="border-line bg-surface-white flex h-fit w-full shrink-0 flex-col items-start justify-start gap-4 rounded-xl border p-5">
                    <span class="text-ink-muted text-xs font-semibold tracking-[1.5px]">TRACKING</span>

                    <div class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-0">
                      @for (status of trackingStatuses; track status; let last = $last) {
                        @if (historyFor(tracking, status); as step) {
                          <div class="flex h-fit w-full shrink-0 flex-row items-start justify-start gap-[14px]">
                            <div class="flex h-fit w-[34px] shrink-0 flex-col items-center justify-start gap-0">
                              <app-tracking-status-icon [status]="status" />
                              @if (!last) {
                                <div class="bg-line h-[30px] w-[2px] shrink-0"></div>
                              }
                            </div>
                            <div class="flex h-fit flex-1 flex-col items-start justify-start gap-[3px] pt-1.5">
                              <span class="text-ink-primary text-[14.5px] font-semibold">{{ stepLabel(status) }}</span>
                              <span class="text-ink-secondary w-full text-[13px] leading-[19px]">{{ formatDateTime(step.datetime) }}</span>
                            </div>
                          </div>
                        }
                      }
                    </div>
                  </div>
                }

                <div class="border-line bg-surface-white flex h-fit w-full shrink-0 flex-col items-start justify-start gap-4 rounded-xl border p-5">
                  <span class="text-ink-muted text-xs font-semibold tracking-[1.5px]">ITEMS ({{ lines().length }})</span>

                  <div class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-4">
                    @for (line of lines(); track line.productId; let last = $last) {
                      <div class="flex h-fit w-full shrink-0 flex-row items-start justify-start gap-[14px]">
                        <div class="bg-surface-subtle h-[88px] w-[76px] shrink-0 rounded-lg"></div>
                        <div class="flex h-[88px] flex-1 flex-col items-start justify-between gap-2">
                          <div class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-[3px]">
                            <span class="text-ink-primary w-full text-[14.5px] font-semibold">
                              {{ line.product ? line.product.name : 'Product no longer listed' }}
                            </span>
                            <span class="text-ink-secondary text-[13px]">Qty {{ line.quantity }}</span>
                          </div>
                          <span class="text-ink-primary text-[14.5px] font-semibold">
                            {{ '$' + formatCents(line.totalCents) }}
                          </span>
                        </div>
                      </div>
                      @if (!last) {
                        <div class="bg-line h-px w-full shrink-0"></div>
                      }
                    }
                  </div>
                </div>
              </div>

              <div class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-5 md:w-[340px]">
                <div class="border-line bg-surface-white flex h-fit w-full shrink-0 flex-col items-start justify-start gap-4 rounded-xl border p-5">
                  <span class="text-ink-muted text-xs font-semibold tracking-[1.5px]">ORDER SUMMARY</span>

                  <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
                    <span class="text-ink-secondary text-sm">Subtotal</span>
                    <span class="text-ink-primary text-sm font-semibold">{{ '$' + formatCents(entry.order.subtotalCents) }}</span>
                  </div>
                  <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
                    <span class="text-ink-secondary text-sm">Shipping</span>
                    <span class="text-ink-primary text-sm font-semibold">
                      {{ toInt(entry.order.shippingCents) === 0 ? 'Free' : '$' + formatCents(entry.order.shippingCents) }}
                    </span>
                  </div>
                  <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
                    <span class="text-ink-secondary text-sm">Taxes</span>
                    <span class="text-ink-primary text-sm font-semibold">{{ '$' + formatCents(entry.order.taxCents) }}</span>
                  </div>
                  <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
                    <span class="text-ink-primary text-[15.5px] font-bold">Total</span>
                    <span class="text-ink-primary text-lg font-bold tracking-[-0.3px]">{{ '$' + formatCents(entry.order.totalCents) }}</span>
                  </div>
                </div>

                @if (address; as deliveryAddress) {
                  <div class="border-line bg-surface-white flex h-fit w-full shrink-0 flex-col items-start justify-start gap-4 rounded-xl border p-5">
                    <span class="text-ink-muted text-xs font-semibold tracking-[1.5px]">DELIVERY ADDRESS</span>
                    <span class="text-ink-primary text-[14.5px] font-semibold">{{ userName }}</span>
                    <p class="text-ink-secondary w-full text-[13.5px] leading-[22px]">
                      {{ deliveryAddress.line1 }}{{ deliveryAddress.line2 ? ', ' + deliveryAddress.line2 : '' }}<br />
                      {{ deliveryAddress.city }} {{ deliveryAddress.postalCode }}, {{ deliveryAddress.country }}<br />
                      {{ userPhone }}
                    </p>
                  </div>
                }
              </div>
            </div>
          </div>
        </div>
      } @else {
        <p class="text-ink-secondary w-full p-9 text-center text-sm">Order not found.</p>
      }
    </div>
  `,
})
export class OrderDetailPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly overlay = inject(OverlayStore);
  protected readonly hasUnreadNotifications = NOTIFICATIONS.some((n) => !n.read);

  protected readonly formatCents = formatCents;
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

  protected readonly placedLabel = computed(() => {
    const current = this.entry();
    if (!current) return '';
    const date = new Date(current.order.createdAt);
    const formatted = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const count = current.order.lines.length;
    return `Placed ${formatted} · ${count} item${count === 1 ? '' : 's'}`;
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

  protected formatDateTime(iso: string): string {
    const date = new Date(iso);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  protected goTo(path: string): void {
    void this.router.navigateByUrl(path);
  }
}
