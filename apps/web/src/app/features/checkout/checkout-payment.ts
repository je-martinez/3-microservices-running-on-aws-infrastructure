import { Component, computed } from '@angular/core';
import { LucideCheck, LucideChevronLeft, LucideCreditCard, LucideLock, LucideShieldCheck } from '@lucide/angular';
import { APP_CONFIG } from '../../core/config/app-config';
import { AppHeader } from '../../core/layout/app-header';
import { formatCents, toInt } from '../../fixtures/api-types';
import { PRODUCTS } from '../../fixtures/catalogue.fixture';
import { CartLine } from '../../shared/ui/cart-line';

/**
 * Design: `Checkout — Payment` (`DOtD2`, 1440) / `Mobile — Checkout Payment`
 * (`P0lhqj`). `App Header` + `Body` — a real page, unlike the cart overlays.
 *
 * Two payment paths exist in the design and `APP_CONFIG.stripeEnabled`
 * decides which one the user gets:
 *   - `false` -> this page's own card fields (`data-testid="checkout-plain"`)
 *   - `true`  -> the Stripe step, laid out in the cart drawer (`hed4V`),
 *     reached via `data-testid="checkout-stripe"` here as a hand-off panel
 *
 * Phase 1 renders both branches and submits neither — no payment backend
 * exists anywhere in this repo (no service, no Terraform, no `.env`).
 */
@Component({
  selector: 'app-checkout-payment',
  imports: [AppHeader, CartLine, LucideCheck, LucideChevronLeft, LucideCreditCard, LucideLock, LucideShieldCheck],
  template: `
    <div class="bg-surface-white flex h-fit min-h-full w-full flex-col items-start justify-start gap-0">
      <app-app-header />

      <div class="bg-surface-body flex w-full flex-1 flex-col items-center justify-start gap-0 p-5 md:p-9">
        <div class="flex h-fit w-full max-w-[1040px] flex-col items-start justify-start gap-[22px]">
          <a class="flex h-fit w-fit shrink-0 flex-row items-center justify-start gap-[7px]" href="/">
            <svg lucideChevronLeft class="text-ink-secondary h-4 w-4"></svg>
            <span class="text-ink-secondary text-sm">Back to cart</span>
          </a>

          <div class="flex h-fit w-full shrink-0 flex-col items-center justify-between gap-4 md:flex-row md:items-center">
            <div class="flex h-fit w-fit shrink-0 flex-col items-start justify-start gap-1">
              <h1 class="text-ink-primary text-2xl font-bold tracking-[-0.8px] md:text-[30px]">Checkout</h1>
              <p class="text-ink-secondary text-sm">{{ itemCount() }} items · {{ total() }} total</p>
            </div>
            <div class="flex h-fit w-fit shrink-0 flex-row items-center justify-start gap-[10px]">
              @for (label of ['Cart', 'Address']; track label) {
                <div class="flex h-fit w-fit shrink-0 flex-row items-center justify-start gap-2">
                  <span class="bg-brand-navy flex h-[22px] w-[22px] shrink-0 flex-row items-center justify-center rounded-full">
                    <svg lucideCheck class="text-surface-white h-3 w-3"></svg>
                  </span>
                  <span class="text-ink-secondary text-[13.5px]">{{ label }}</span>
                </div>
                <div class="bg-line-strong h-px w-5 shrink-0"></div>
              }
              <div class="flex h-fit w-fit shrink-0 flex-row items-center justify-start gap-2">
                <span class="bg-brand-orange flex h-[22px] w-[22px] shrink-0 flex-row items-center justify-center rounded-full">
                  <svg lucideCreditCard class="text-surface-white h-3 w-3"></svg>
                </span>
                <span class="text-ink-primary text-[13.5px] font-semibold">Payment</span>
              </div>
            </div>
          </div>

          <div class="flex w-full flex-col items-start justify-start gap-6 md:flex-row">
            <div class="flex h-fit flex-1 flex-col items-start justify-start gap-5">
              <div class="bg-surface-white border-line flex h-fit w-full shrink-0 flex-col items-start justify-start gap-4 rounded-xl border p-5">
                <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
                  <span class="text-ink-muted text-xs font-semibold tracking-[1.5px]">DELIVERY ADDRESS</span>
                  <span class="text-brand-navy text-sm font-semibold">Change</span>
                </div>
                <span class="text-ink-primary text-[14.5px] font-semibold">Jose Martinez</span>
                <p class="text-ink-secondary w-full text-[13.5px] leading-[22px]">
                  Av. Rómulo Betancourt 1204, Apto 5B<br />
                  Santo Domingo 10604, DO · +1 809 555 0142
                </p>
              </div>

              @if (stripeEnabled()) {
                <div data-testid="checkout-stripe" class="bg-surface-white border-line flex h-fit w-full shrink-0 flex-col items-start justify-start gap-4 rounded-xl border p-5">
                  <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
                    <span class="text-ink-muted text-xs font-semibold tracking-[1.5px]">PAYMENT</span>
                    <div class="flex h-fit w-fit shrink-0 flex-row items-center justify-start gap-[6px]">
                      <svg lucideLock class="text-ink-muted h-3 w-3"></svg>
                      <span class="text-ink-muted text-[12.5px]">Encrypted</span>
                    </div>
                  </div>
                  <p class="text-ink-secondary w-full text-sm">
                    Payment is completed in the cart — open the cart to pay with Stripe.
                  </p>
                  <div class="text-ink-muted flex h-fit w-full shrink-0 flex-row items-center justify-center gap-[5px] text-xs">
                    Powered by <span class="text-ink-secondary font-bold tracking-[-0.3px]">Stripe</span>
                  </div>
                </div>
              } @else {
                <div data-testid="checkout-plain" class="bg-surface-white border-line flex h-fit w-full shrink-0 flex-col items-start justify-start gap-4 rounded-xl border p-5">
                  <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
                    <span class="text-ink-muted text-xs font-semibold tracking-[1.5px]">PAYMENT</span>
                    <div class="flex h-fit w-fit shrink-0 flex-row items-center justify-start gap-[6px]">
                      <svg lucideLock class="text-ink-muted h-[13px] w-[13px]"></svg>
                      <span class="text-ink-muted text-[12.5px]">Encrypted</span>
                    </div>
                  </div>

                  <div class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-[14px]">
                    <div class="border-brand-orange bg-brand-orange-light flex h-[60px] w-full shrink-0 flex-row items-center justify-center gap-[6px] rounded-md border-[1.5px]">
                      <svg lucideCreditCard class="text-brand-orange-text h-[19px] w-[19px]"></svg>
                      <span class="text-ink-primary text-[12.5px] font-semibold">Card</span>
                    </div>

                    <label class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-[6px]">
                      <span class="text-ink-primary text-[13px] font-medium">Card number</span>
                      <span class="border-line bg-surface-white flex h-[46px] w-full items-center gap-[10px] rounded-md border px-3">
                        <svg lucideCreditCard class="text-ink-muted h-[17px] w-[17px] shrink-0"></svg>
                        <input
                          type="text"
                          placeholder="1234 1234 1234 1234"
                          class="text-ink-primary placeholder:text-ink-muted w-full flex-1 border-0 bg-transparent text-[14.5px] outline-none"
                        />
                      </span>
                    </label>

                    <div class="flex h-fit w-full shrink-0 flex-row items-start justify-start gap-3">
                      <label class="flex h-fit flex-1 flex-col items-start justify-start gap-[6px]">
                        <span class="text-ink-primary text-[13px] font-medium">Expiration date</span>
                        <span class="border-line bg-surface-white flex h-[46px] w-full items-center gap-[10px] rounded-md border px-3">
                          <input
                            type="text"
                            placeholder="MM / YY"
                            class="text-ink-primary placeholder:text-ink-muted w-full flex-1 border-0 bg-transparent text-[14.5px] outline-none"
                          />
                        </span>
                      </label>
                      <label class="flex h-fit flex-1 flex-col items-start justify-start gap-[6px]">
                        <span class="text-ink-primary text-[13px] font-medium">Security code</span>
                        <span class="border-line bg-surface-white flex h-[46px] w-full items-center gap-[10px] rounded-md border px-3">
                          <input
                            type="text"
                            placeholder="CVC"
                            class="text-ink-muted placeholder:text-ink-muted w-full flex-1 border-0 bg-transparent text-[14.5px] outline-none"
                          />
                        </span>
                      </label>
                    </div>

                    <div class="flex h-fit w-full shrink-0 flex-row items-start justify-start gap-3">
                      <label class="flex h-fit flex-1 flex-col items-start justify-start gap-[6px]">
                        <span class="text-ink-primary text-[13px] font-medium">Country or region</span>
                        <span class="border-line bg-surface-white flex h-[46px] w-full items-center gap-[10px] rounded-md border px-3">
                          <input
                            type="text"
                            value="Dominican Republic"
                            class="text-ink-primary w-full flex-1 border-0 bg-transparent text-[14.5px] outline-none"
                          />
                        </span>
                      </label>
                      <label class="flex h-fit flex-1 flex-col items-start justify-start gap-[6px]">
                        <span class="text-ink-primary text-[13px] font-medium">ZIP</span>
                        <span class="border-line bg-surface-white flex h-[46px] w-full items-center gap-[10px] rounded-md border px-3">
                          <input
                            type="text"
                            value="10604"
                            class="text-ink-primary w-full flex-1 border-0 bg-transparent text-[14.5px] outline-none"
                          />
                        </span>
                      </label>
                    </div>
                  </div>

                  <div class="border-line h-px w-full shrink-0"></div>
                  <div class="text-ink-muted flex h-fit w-full shrink-0 flex-row items-center justify-center gap-[5px] text-xs">
                    Powered by <span class="text-ink-secondary font-bold tracking-[-0.3px]">Stripe</span>
                  </div>
                </div>
              }

              <button
                type="button"
                class="bg-brand-orange text-surface-white flex h-[58px] w-full shrink-0 flex-row items-center justify-center gap-[10px] rounded-md text-base font-semibold"
              >
                Pay {{ total() }}
                <svg lucideLock class="h-[19px] w-[19px]"></svg>
              </button>

              <div class="flex h-fit w-full shrink-0 flex-row items-center justify-center gap-2">
                <svg lucideShieldCheck class="text-ink-muted h-3.5 w-3.5"></svg>
                <span class="text-ink-muted text-[12.5px]">You'll be charged {{ total() }}. Free returns within 30 days.</span>
              </div>
            </div>

            <div class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-5 md:w-[340px]">
              <div class="bg-surface-white border-line flex h-fit w-full shrink-0 flex-col items-start justify-start gap-4 rounded-xl border p-5">
                <span class="text-ink-muted text-xs font-semibold tracking-[1.5px]">ORDER SUMMARY</span>
                @for (product of cartItems; track product.id) {
                  <app-cart-line [product]="product" />
                }
                <div class="border-line h-px w-full shrink-0"></div>
                <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
                  <span class="text-ink-secondary text-sm">Subtotal</span>
                  <span class="text-ink-primary text-sm font-semibold">{{ total() }}</span>
                </div>
                <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
                  <span class="text-ink-secondary text-sm">Shipping</span>
                  <span class="text-ink-primary text-sm font-semibold">Free</span>
                </div>
                <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
                  <span class="text-ink-secondary text-sm">Taxes</span>
                  <span class="text-ink-primary text-sm font-semibold">$0.00</span>
                </div>
                <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
                  <span class="text-ink-primary text-[15.5px] font-bold">Total</span>
                  <span class="text-ink-primary text-lg font-bold tracking-[-0.3px]">{{ total() }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
})
export class CheckoutPaymentPage {
  /** Read from APP_CONFIG, never from import.meta.env — see app-config.ts. */
  protected readonly stripeEnabled = computed(() => APP_CONFIG.stripeEnabled);

  protected readonly cartItems = PRODUCTS.slice(0, 3);
  protected readonly itemCount = computed(() => this.cartItems.length);
  protected readonly total = computed(
    () => `$${formatCents(this.cartItems.reduce((sum, product) => sum + toInt(product.unitPriceCents), 0))}`,
  );
}
