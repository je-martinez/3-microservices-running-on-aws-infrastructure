import { Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { LucideArrowLeft, LucideRefreshCw, LucideTriangleAlert } from '@lucide/angular';
import { firstValueFrom, map } from 'rxjs';
import { CatalogueApi } from '../../core/api/catalogue-api';
import { OrdersApi } from '../../core/api/orders-api';
import {
  joinOrderLine,
  toInt,
  TRACKING_STATUSES,
  type OrderWithTracking,
  type Product,
  type Tracking,
  type TrackingStatus,
} from '../../core/api/types';
import { SessionStore } from '../../core/auth/session-store';
import { ApiError } from '../../core/http/api-client';
import { authErrorMessage } from '../auth/auth-errors';
import { formatDateTime, formatPlacedLabel } from '../../shared/date/format-date';
import { StatusBadge } from '../../shared/ui/status-badge';
import { TrackingStatusIcon } from '../../shared/ui/tracking-status-icon';

/**
 * Design: `Orders — Detail` (`x7ABM`, 1040 desktop / `eq3Tk`, mobile).
 *
 * CONTRACT: A line whose `product` is null (delisted) still renders a row with a
 * placeholder name — dropping it silently loses an item the buyer paid for.
 * `tracking: null` skips the timeline card rather than emptying it.
 * See [[angular-component-authoring]]
 */
@Component({
  selector: 'app-order-detail',
  imports: [LucideArrowLeft, LucideRefreshCw, LucideTriangleAlert, StatusBadge, TrackingStatusIcon],
  templateUrl: './order-detail.html',
})
export class OrderDetailPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly ordersApi = inject(OrdersApi);
  private readonly catalogueApi = inject(CatalogueApi);
  private readonly session = inject(SessionStore);

  /** Timeline rows: `Aug 2, 2026 · 10:24 am` (see shared/date/format-date.ts). */
  protected readonly formatDateTime = formatDateTime;
  protected readonly toInt = toInt;
  protected readonly trackingStatuses = TRACKING_STATUSES;

  protected readonly entry = signal<OrderWithTracking | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  /** 404 means "not yours or not real" — a different message from a failure. */
  protected readonly notFound = signal(false);

  private readonly catalogue = signal<readonly Product[]>([]);

  private readonly orderId = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('orderId'))),
    { initialValue: this.route.snapshot.paramMap.get('orderId') },
  );

  constructor() {
    // WHY: keyed on the route param, so navigating between two order URLs
    // without leaving this component refetches instead of showing the first.
    effect(() => {
      const id = this.orderId();
      void this.load(id);
    });
  }

  protected reload(): void {
    void this.load(this.orderId());
  }

  private async load(orderId: string | null): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.notFound.set(false);
    if (!orderId) {
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }
    try {
      // WHY: the catalogue rides along because OrderLineDto carries only
      // productId — a line has no name or image to render without it.
      const [entry, catalogue] = await Promise.all([
        firstValueFrom(this.ordersApi.getOrder(orderId)),
        firstValueFrom(this.catalogueApi.listProducts()),
      ]);
      this.entry.set(entry);
      this.catalogue.set(catalogue);
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 404) {
        this.notFound.set(true);
      } else {
        this.error.set(authErrorMessage(error));
      }
    } finally {
      this.loading.set(false);
    }
  }

  protected readonly lines = computed(() => {
    const current = this.entry();
    return current ? current.order.lines.map((line) => joinOrderLine(line, this.catalogue())) : [];
  });

  /**
   * Shared with `OrderCard`, which renders the identical line — see
   * `shared/date/format-date.ts`.
   */
  protected readonly placedLabel = computed(() => {
    const current = this.entry();
    if (!current) return '';
    return formatPlacedLabel(current.order.createdAt, current.order.lines.length);
  });

  /**
   * CONTRACT: The delivery card reads the SIGNED-IN user, not the order — an
   * order carries no address on the wire. It renders only once the profile has
   * loaded; `User.address` is `anyOf: [{}, null]` in services/users/openapi.yaml,
   * so the shape here is design-derived. See [[openapi-specs]]
   */
  protected readonly address = computed(() => this.session.user()?.address ?? null);
  protected readonly userName = computed(() => this.session.user()?.fullName ?? '');
  protected readonly userPhone = computed(() => this.session.user()?.phoneNumber ?? '');

  protected historyFor(tracking: Tracking, status: TrackingStatus) {
    return tracking.history.find((h) => h.status === status) ?? null;
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
