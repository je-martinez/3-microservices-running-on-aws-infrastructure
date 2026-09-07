import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  LucideCheck,
  LucideChevronLeft,
  LucideCreditCard,
  LucideLock,
  LucideRefreshCw,
  LucideShieldCheck,
  LucideShoppingBag,
  LucideTriangleAlert,
} from '@lucide/angular';
import { APP_CONFIG } from '../../core/config/app-config';
import { type Address, toInt } from '../../core/api/types';
import { OrdersApi } from '../../core/api/orders-api';
import { UsersApi } from '../../core/api/users-api';
import { SessionStore } from '../../core/auth/session-store';
import { CartStore } from '../../core/cart/cart-store';
import { authErrorMessage } from '../auth/auth-errors';
import { CartLine } from '../../shared/ui/cart-line';
import { Field } from '../../shared/ui/field';
import { PhoneField } from '../../shared/ui/phone-field';
import { StreetAutocomplete } from '../../shared/ui/street-autocomplete';

/**
 * Design: `Checkout — Payment` (`DOtD2`, 1440) / `Mobile — Checkout Payment`
 * (`P0lhqj`). `App Header` + `Body` — a real page, unlike the cart overlays.
 * Loading, error and empty states use existing tokens: the `.pen` has no frame
 * for any of the three.
 *
 * CONTRACT: This page owns BOTH the delivery address and POST /orders — the
 * cart drawer only routes here. Placing an order without an address ships goods
 * nowhere, so `canPay` requires one and the form below is how it is collected.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
@Component({
  selector: 'app-checkout-payment',
  imports: [
    RouterLink,
    CartLine,
    Field,
    PhoneField,
    StreetAutocomplete,
    LucideCheck,
    LucideChevronLeft,
    LucideCreditCard,
    LucideLock,
    LucideRefreshCw,
    LucideShieldCheck,
    LucideShoppingBag,
    LucideTriangleAlert,
  ],
  templateUrl: './checkout-payment.html',
})
export class CheckoutPaymentPage {
  private readonly ordersApi = inject(OrdersApi);
  private readonly usersApi = inject(UsersApi);
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);

  protected readonly cart = inject(CartStore);

  /** Read from APP_CONFIG, never from import.meta.env — see app-config.ts. */
  protected readonly stripeEnabled = computed(() => APP_CONFIG.stripeEnabled);

  protected readonly placing = signal(false);
  protected readonly checkoutError = signal<string | null>(null);

  protected readonly itemCount = computed(() => this.cart.itemCount());

  /** The saved delivery address, or null when the profile carries none. */
  protected readonly address = computed<Address | null>(() => this.session.user()?.address ?? null);
  protected readonly phoneNumber = computed(() => this.session.user()?.phoneNumber ?? null);
  protected readonly fullName = computed(() => this.session.user()?.fullName ?? '');

  /** Form state for the no-address branch, in the design's three fields. */
  protected readonly street = signal('');
  protected readonly cityAndPostalCode = signal('');
  protected readonly phoneInput = signal('');
  protected readonly savingAddress = signal(false);
  protected readonly addressError = signal<string | null>(null);

  /**
   * CONTRACT: The address a suggestion resolved, held APART from the visible
   * fields. Round-tripping it through `cityAndPostalCode` hands it back to the
   * heuristic parse, which has nowhere to put `state` and drops the province
   * from every autocompleted address. Null while the buyer types freehand.
   */
  protected readonly resolvedAddress = signal<Address | null>(null);

  /**
   * The flag's pre-typing default only. Once a digit is typed the NUMBER
   * decides the country, so this never overrides what the buyer entered — and
   * it matches the `country` parseAddress() writes.
   */
  protected readonly seedCountry = computed(() => this.address()?.country ?? 'DO');

  protected readonly canSaveAddress = computed(
    () =>
      this.street().trim() !== '' &&
      this.cityAndPostalCode().trim() !== '' &&
      !this.savingAddress(),
  );

  /**
   * CONTRACT: Every figure here is the server's `formatted` string, rendered
   * verbatim. Re-deriving one from `cents` shows an amount a cent away from
   * what is actually charged — the server rounds tax per line.
   * See [[money-representation]]
   */
  protected readonly totals = computed(() => {
    const cart = this.cart.cart();
    if (!cart) return null;
    return {
      subtotal: cart.subtotal.formatted,
      tax: cart.tax.formatted,
      shipping: cart.shipping.formatted,
      total: cart.total.formatted,
    };
  });

  /**
   * CONTRACT: A missing address disables paying. It is collected precisely so
   * the order has somewhere to go; charging first and asking after leaves a
   * paid order the warehouse cannot ship.
   */
  protected readonly canPay = computed(
    () =>
      this.cart.canCheckout() &&
      !this.cart.saving() &&
      !this.placing() &&
      this.address() !== null,
  );

  constructor() {
    void this.cart.load();
  }

  /**
   * CONTRACT: Store the SessionStore user the response carries, not a locally
   * assembled one. PATCH /users/me answers with the whole profile, and the card
   * re-renders off the session — assembling it here would drift from whatever
   * the service normalised.
   */
  protected async saveAddress(): Promise<void> {
    if (!this.canSaveAddress()) return;

    this.savingAddress.set(true);
    this.addressError.set(null);
    try {
      const updated = await firstValueFrom(
        this.usersApi.updateMe({
          address: this.parseAddress(),
          ...(this.phoneInput().trim() === '' ? {} : { phoneNumber: this.phoneInput().trim() }),
        }),
      );
      this.session.setUser(updated);
    } catch (error: unknown) {
      this.addressError.set(authErrorMessage(error));
    } finally {
      this.savingAddress.set(false);
    }
  }

  /**
   * CONTRACT: Mirror the resolved city and postal code into the VISIBLE field
   * as well as into `resolvedAddress`. The design has three inputs and no frame
   * for a fourth, so a value saved but never shown is a value the buyer cannot
   * correct — and `canSaveAddress()` would stay false with the field empty.
   */
  protected onAddressSuggested(address: Address): void {
    this.resolvedAddress.set(address);
    this.street.set(address.line1);
    this.cityAndPostalCode.set(
      [address.city, address.postalCode].filter((part) => part !== '').join(', '),
    );
  }

  /**
   * CONTRACT: Editing the street KEEPS the resolved city/state/postal code —
   * appending the house number is the expected next action, since no Dominican
   * suggestion carries one. Only clearing the street drops the resolution,
   * because a blank field means the buyer is starting over.
   */
  protected onStreetTyped(value: string): void {
    if (value.trim() === '') this.resolvedAddress.set(null);
    this.street.set(value);
  }

  /**
   * CONTRACT: Editing city/postal code by hand DROPS the resolution and returns
   * to the heuristic parse. Keeping it would save the suggestion's city while
   * the buyer looks at the one they just corrected.
   */
  protected onCityAndPostalCodeTyped(value: string): void {
    this.resolvedAddress.set(null);
    this.cityAndPostalCode.set(value);
  }

  /**
   * WHY: The design collects city and postal code in ONE field, while the API
   * stores them apart. A chosen suggestion knows them exactly, so its values
   * win; otherwise the last comma-separated part is the postal code when it
   * looks like one, and the code is left empty rather than guessed.
   */
  private parseAddress(): Address {
    const resolved = this.resolvedAddress();
    // The street still comes from the field: the buyer adds the house number
    // the suggestion has no data for.
    if (resolved) return { ...resolved, line1: this.street().trim() };

    const parts = this.cityAndPostalCode()
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    const last = parts.length > 1 ? parts[parts.length - 1] : '';
    const isPostalCode = last !== '' && /^[\w -]{3,10}$/.test(last);
    return {
      line1: this.street().trim(),
      line2: null,
      city: (isPostalCode ? parts.slice(0, -1).join(', ') : parts.join(', ')) || '',
      state: '',
      postalCode: isPostalCode ? last : '',
      country: 'DO',
    };
  }

  /**
   * CONTRACT: Send the cart's own lines explicitly — POST /orders does NOT read
   * the cart and answers 400 on an empty body. The server DELETES the cart on
   * success, so the local one is dropped rather than re-read.
   * See [[2026-09-04-web-gateway-integration-design]]
   */
  protected async pay(): Promise<void> {
    const lines = this.cart
      .lines()
      .filter((line) => line.available)
      .map((line) => ({ productId: line.productId, quantity: toInt(line.quantity) }));
    if (lines.length === 0) return;

    this.placing.set(true);
    this.checkoutError.set(null);
    try {
      const order = await firstValueFrom(this.ordersApi.createOrder(lines));
      this.cart.forgetAfterCheckout();
      await this.router.navigate(['/orders', order.id]);
    } catch (error: unknown) {
      // 409 is the race `canCheckout` cannot rule out: stock went in the gap
      // between reading the cart and charging it.
      this.checkoutError.set(
        authErrorMessage(error, {
          409: 'Someone bought the last one while you were checking out. Adjust your cart and try again.',
        }),
      );
      void this.cart.load();
    } finally {
      this.placing.set(false);
    }
  }
}
