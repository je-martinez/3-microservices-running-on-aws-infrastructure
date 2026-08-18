import { Component, computed, inject, input } from '@angular/core';
import {
  LucideBuilding2,
  LucideChevronLeft,
  LucideCreditCard,
  LucideDynamicIcon,
  LucideMapPin,
  LucidePhone,
  LucideShieldCheck,
  LucideX,
} from '@lucide/angular';
import { APP_CONFIG } from '../../core/config/app-config';
import { OverlayStore } from '../../core/overlay/overlay-store';
import { type Address, formatCents, type Product, toInt } from '../../fixtures/api-types';
import { PRODUCTS } from '../../fixtures/catalogue.fixture';
import { CartLine } from '../../shared/ui/cart-line';

/**
 * Design: `Cart Drawer` (`ET6dr`). ONE component covers three frame pairs
 * (spec D8) — they differ only by state, never by structure:
 *   - `Home — Cart Open (saved address)` (`wevx6`/`OIjLT`) — `step: "cart"`,
 *     `address` set.
 *   - `Home — Cart Open (no address)` (`eig49`/`KzgZN`) — `step: "cart"`,
 *     `address` null: renders the inline address form instead of the
 *     "Deliver to" card.
 *   - `Home — Cart Payment (Stripe)` (`hed4V`/`NfXeq`) — `step: "payment"`.
 *     Reachable only when `APP_CONFIG.stripeEnabled` is true; the build
 *     cannot open a step it has disabled (spec D-checkout).
 *
 * Mounts off `OverlayStore` in `Home`, ABOVE its own Scrim (`z-40`) — this
 * panel is `z-50`, or it would render underneath the scrim meant to sit
 * behind it (see task-10-brief.md).
 *
 * No cart store exists in Phase 1: cart contents are the first three
 * fixture products, mirroring how `Home` renders the flat fixture catalogue.
 */
@Component({
  selector: 'app-cart-drawer',
  imports: [
    CartLine,
    LucideBuilding2,
    LucideChevronLeft,
    LucideCreditCard,
    LucideDynamicIcon,
    LucideMapPin,
    LucidePhone,
    LucideShieldCheck,
    LucideX,
  ],
  template: `
    <aside
      class="bg-surface-white fixed top-0 right-0 z-50 flex h-full w-full flex-col items-start justify-start gap-0 overflow-hidden shadow-[-10px_0px_44px_0px_#1A1A2E26]"
      [class]="step() === 'payment' ? 'md:w-[520px]' : 'md:w-[440px]'"
    >
      <div
        class="border-line flex h-fit w-full shrink-0 flex-row items-center justify-between border-b px-6 py-[22px]"
      >
        <div class="flex h-fit w-fit shrink-0 flex-row items-center justify-start gap-[9px]">
          @if (step() === 'payment') {
            <button
              type="button"
              class="bg-surface-subtle flex h-8 w-8 shrink-0 flex-row items-center justify-center rounded-lg"
              (click)="overlay.openCart()"
            >
              <svg lucideChevronLeft class="text-ink-primary h-4 w-4"></svg>
            </button>
          }
          <h2 class="text-ink-primary text-[19px] font-bold tracking-[-0.4px]">
            {{ step() === 'payment' ? 'Payment' : 'Your cart' }}
          </h2>
          <span class="text-ink-secondary text-[13.5px]">
            {{ step() === 'payment' ? 'Step 2 of 2' : cartItems.length + ' items' }}
          </span>
        </div>
        <button
          type="button"
          class="bg-surface-subtle flex h-9 w-9 shrink-0 flex-row items-center justify-center rounded-lg"
          (click)="overlay.close()"
        >
          <svg lucideX class="text-ink-primary h-[17px] w-[17px]"></svg>
        </button>
      </div>

      @if (step() === 'cart') {
        <div class="flex w-full flex-1 flex-col items-start justify-start gap-5 overflow-y-auto px-6 py-[22px]">
          @for (product of cartItems; track product.id) {
            <app-cart-line [product]="product" />
          }
        </div>
      } @else {
        <div class="flex w-full flex-1 flex-col items-start justify-start gap-4 overflow-y-auto px-6 py-[22px]">
          @if (address(); as deliveryAddress) {
            <div class="bg-surface-subtle border-line flex h-fit w-full shrink-0 flex-col items-start justify-start gap-[6px] rounded-md border p-[14px]">
              <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
                <div class="flex h-fit w-fit shrink-0 flex-row items-center justify-start gap-[7px]">
                  <svg lucideMapPin class="text-ink-secondary h-[15px] w-[15px]"></svg>
                  <span class="text-ink-secondary text-[12.5px] font-semibold tracking-[0.4px]">Deliver to</span>
                </div>
                <span class="text-brand-navy text-[12.5px] font-semibold">Change</span>
              </div>
              <p class="text-ink-primary w-full text-[13px] leading-5">
                {{ deliveryAddress.line1 }}{{ deliveryAddress.line2 ? ', ' + deliveryAddress.line2 : '' }},
                {{ deliveryAddress.city }}, {{ deliveryAddress.state }} {{ deliveryAddress.postalCode }},
                {{ deliveryAddress.country }}
              </p>
            </div>
          }

          <div class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-3">
            <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
              <span class="text-ink-muted text-[11.5px] font-semibold tracking-[1.4px]">PAYMENT</span>
              <span class="text-ink-muted text-xs">Encrypted</span>
            </div>
            <!-- Design: Stripe Payment Element (a hosted Stripe iframe in
                 production). Only reachable when stripeEnabled is true; this
                 tab-and-fields layout matches the frame but wires to nothing. -->
            <div class="border-brand-orange bg-brand-orange-light flex h-[58px] w-full shrink-0 flex-row items-center justify-center gap-[6px] rounded-md border-[1.5px]">
              <svg lucideCreditCard class="text-brand-orange-text h-[19px] w-[19px]"></svg>
              <span class="text-ink-primary text-[12.5px] font-semibold">Card</span>
            </div>
            <div class="text-ink-muted flex h-fit w-full shrink-0 flex-row items-center justify-center gap-[5px] text-[11.5px]">
              Powered by <span class="text-ink-secondary font-bold tracking-[-0.3px]">Stripe</span>
            </div>
          </div>
        </div>
      }

      <div class="border-line flex h-fit w-full shrink-0 flex-col items-start justify-start gap-[18px] border-t bg-surface-white px-6 py-[22px]">
        @if (step() === 'cart' && !address()) {
          <div class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-4">
            <div class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-1">
              <h3 class="text-ink-primary text-[15px] font-semibold">Add a delivery address</h3>
              <p class="text-ink-secondary w-full text-[13px] leading-[19px]">
                We need it once — we'll save it to your profile.
              </p>
            </div>
            <label class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-2">
              <span class="text-ink-primary text-sm font-semibold">Street address</span>
              <span class="border-line bg-surface-white flex h-[58px] w-full items-center gap-[13px] rounded-md border px-[18px]">
                <svg lucideMapPin class="text-ink-muted h-[19px] w-[19px] shrink-0"></svg>
                <input
                  type="text"
                  placeholder="Street, number, apartment"
                  class="text-ink-primary placeholder:text-ink-muted w-full flex-1 border-0 bg-transparent text-base outline-none"
                />
              </span>
            </label>
            <label class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-2">
              <span class="text-ink-primary text-sm font-semibold">City and postal code</span>
              <span class="border-line bg-surface-white flex h-[58px] w-full items-center gap-[13px] rounded-md border px-[18px]">
                <svg lucideBuilding2 class="text-ink-muted h-[19px] w-[19px] shrink-0"></svg>
                <input
                  type="text"
                  placeholder="Santo Domingo, 10604"
                  class="text-ink-primary placeholder:text-ink-muted w-full flex-1 border-0 bg-transparent text-base outline-none"
                />
              </span>
            </label>
            <label class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-2">
              <span class="text-ink-primary text-sm font-semibold">Phone number</span>
              <span class="border-line bg-surface-white flex h-[58px] w-full items-center gap-[13px] rounded-md border px-[18px]">
                <svg lucidePhone class="text-ink-muted h-[19px] w-[19px] shrink-0"></svg>
                <input
                  type="tel"
                  placeholder="+1 809 000 0000"
                  class="text-ink-primary placeholder:text-ink-muted w-full flex-1 border-0 bg-transparent text-base outline-none"
                />
              </span>
            </label>
          </div>
        }

        <div class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-[9px]">
          <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
            <span class="text-ink-secondary text-sm">Subtotal</span>
            <span class="text-ink-primary text-sm font-semibold">{{ subtotal() }}</span>
          </div>
          <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
            <span class="text-ink-secondary text-sm">Shipping</span>
            <span class="text-ink-primary text-sm font-semibold">Free</span>
          </div>
          <div class="flex h-fit w-full shrink-0 flex-row items-center justify-between">
            <span class="text-ink-primary text-[15.5px] font-bold">Total</span>
            <span class="text-ink-primary text-lg font-bold tracking-[-0.3px]">{{ subtotal() }}</span>
          </div>
        </div>

        <button
          type="button"
          class="bg-brand-orange text-surface-white flex h-[58px] w-full shrink-0 flex-row items-center justify-center gap-[10px] rounded-md text-base font-semibold"
          (click)="continue()"
        >
          {{ continueLabel() }}
          <svg
            [lucideIcon]="step() === 'payment' ? 'lock' : 'arrow-right'"
            class="h-[19px] w-[19px]"
          ></svg>
        </button>

        <div class="flex h-fit w-full shrink-0 flex-row items-center justify-center gap-[7px]">
          <svg lucideShieldCheck class="text-ink-muted h-3.5 w-3.5"></svg>
          <span class="text-ink-muted text-[12.5px]">Secure checkout · Free returns for 30 days</span>
        </div>
      </div>
    </aside>
  `,
})
export class CartDrawer {
  readonly address = input<Address | null>(null);
  readonly step = input<'cart' | 'payment'>('cart');

  protected readonly overlay = inject(OverlayStore);
  protected readonly cartItems: readonly Product[] = PRODUCTS.slice(0, 3);

  protected readonly subtotal = computed(() =>
    `$${formatCents(this.cartItems.reduce((sum, product) => sum + toInt(product.unitPriceCents), 0))}`,
  );

  protected readonly continueLabel = computed(() => {
    if (this.step() === 'payment') return `Pay ${this.subtotal()}`;
    return this.address() ? 'Continue to payment' : 'Save address & continue';
  });

  // The Stripe step only exists in the build when the flag enables it — the
  // drawer cannot reach `cart-payment` otherwise (spec D-checkout).
  protected continue(): void {
    if (this.step() === 'payment') return; // Neither path submits (no payment backend).
    if (APP_CONFIG.stripeEnabled) {
      this.overlay.openCartPayment();
    }
  }
}
