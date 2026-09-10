import { DOCUMENT } from '@angular/common';
import {
  Component,
  computed,
  effect,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  LucideArrowLeft,
  LucideCircleCheck,
  LucideRefreshCw,
  LucideTriangleAlert,
} from '@lucide/angular';
import { firstValueFrom, map } from 'rxjs';
import { CatalogueApi } from '../../core/api/catalogue-api';
import { OrdersApi } from '../../core/api/orders-api';
import {
  joinOrderLine,
  toInt,
  TRACKING_STATUSES,
  type OrderWithTracking,
  type Product,
  type ResolvedOrderLine,
  type Tracking,
  type TrackingStatus,
} from '../../core/api/types';
import { SessionStore } from '../../core/auth/session-store';
import { ApiError } from '../../core/http/api-client';
import { authErrorMessage } from '../auth/auth-errors';
import { formatDateTime, formatPlacedLabel } from '../../shared/date/format-date';
import { ButtonGhost } from '../../shared/ui/button-ghost';
import { StatusBadge } from '../../shared/ui/status-badge';
import { TrackingStatusIcon } from '../../shared/ui/tracking-status-icon';

/** Narrows the untyped navigation-state bag to the one flag this page reads. */
function readJustPlaced(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'justPlaced' in state
    ? state.justPlaced === true
    : false;
}

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
  imports: [
    ButtonGhost,
    LucideArrowLeft,
    LucideCircleCheck,
    LucideRefreshCw,
    LucideTriangleAlert,
    StatusBadge,
    TrackingStatusIcon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './order-detail.html',
})
export class OrderDetailPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
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

  /**
   * CONTRACT: Read the navigation state HERE, in a field initializer — NOT in
   * an effect or lifecycle hook. `getCurrentNavigation()` is non-null only
   * mid-navigation, so by then it returns null and the banner never appears
   * after checkout. `history.state` outlives the navigation but is absent on a
   * reload and on a later visit, which is what keeps this one-shot.
   * See [[angular-component-authoring]]
   */
  protected readonly justPlaced = signal(
    readJustPlaced(this.router.getCurrentNavigation()?.extras.state) ||
      readJustPlaced(this.document.defaultView?.history.state),
  );

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
      // WHY: the catalogue rides along to name a line placed before the order
      // snapshot existed; those carry `name: null` and nothing else supplies it.
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
   * CONTRACT: The line's own snapshot wins over the catalogue. It is what the
   * buyer paid for, so a product renamed since must still show its old name
   * here. The join is the fallback only for an order placed before the
   * snapshot existed, which carries `name: null`.
   */
  protected lineName(line: ResolvedOrderLine): string {
    return line.name ?? line.product?.name ?? 'Product no longer listed';
  }

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

  /**
   * CONTRACT: The address comes from the signed-in user. When the profile has
   * not loaded there is no address to name, so the sentence drops the clause
   * entirely — rendering an empty gap reads as a bug, and the design's
   * `jose@3mrai.com` is mock copy that must never ship.
   */
  protected readonly confirmationSentTo = computed(() => {
    const email = this.session.user()?.email;
    return email ? `We sent the confirmation to ${email}.` : 'We sent you the confirmation.';
  });

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
