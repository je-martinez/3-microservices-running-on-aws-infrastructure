import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';
import { RouterLink } from '@angular/router';
import { LucideCheck, LucideChevronLeft, LucideCreditCard, LucideLock, LucideShieldCheck } from '@lucide/angular';
import { APP_CONFIG } from '../../core/config/app-config';
import { type Product, toInt } from '../../core/api/types';
import { CatalogueApi } from '../../core/api/catalogue-api';
import { formatCentsAsUsd } from '../../shared/money/format-money';
import { CartLine } from '../../shared/ui/cart-line';

/**
 * Design: `Checkout — Payment` (`DOtD2`, 1440) / `Mobile — Checkout Payment`
 * (`P0lhqj`). `App Header` + `Body` — a real page, unlike the cart overlays.
 *
 * CONTRACT: `APP_CONFIG.stripeEnabled` alone picks the payment path — false
 * renders this page's card fields (`checkout-plain`), true hands off to the
 * Stripe step in the cart drawer (`hed4V`, via `checkout-stripe`). Reaching
 * Stripe with the flag off exposes a path the build disabled. Phase 1 renders
 * both branches and submits neither; this repo has no payment backend.
 * See [[angular-component-authoring]]
 */
@Component({
  selector: 'app-checkout-payment',
  imports: [RouterLink, CartLine, LucideCheck, LucideChevronLeft, LucideCreditCard, LucideLock, LucideShieldCheck],
  templateUrl: './checkout-payment.html',
})
export class CheckoutPaymentPage {
  /** Read from APP_CONFIG, never from import.meta.env — see app-config.ts. */
  protected readonly stripeEnabled = computed(() => APP_CONFIG.stripeEnabled);

  /**
   * TODO(JE-245): Replace with GET /cart. This issue wires the catalogue,
   * orders and profile only; with no cart store yet the summary keeps showing
   * three products as its stand-in contents — now real ones, so it cannot
   * outlive the deleted fixture.
   */
  private readonly catalogue = toSignal(
    inject(CatalogueApi)
      .listProducts()
      .pipe(catchError(() => of<Product[]>([]))),
    { initialValue: [] as Product[] },
  );

  protected readonly cartItems = computed<readonly Product[]>(() => this.catalogue().slice(0, 3));
  protected readonly itemCount = computed(() => this.cartItems().length);
  protected readonly total = computed(() =>
    formatCentsAsUsd(this.cartItems().reduce((sum, p) => sum + toInt(p.unitPrice.cents), 0)),
  );
}
