import { Component, computed, inject, signal, type WritableSignal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  LucideChevronLeft,
  LucideCreditCard,
  LucideDynamicIcon,
  LucideLock,
  LucideRefreshCw,
  LucideShieldCheck,
  LucideShoppingBag,
  LucideTriangleAlert,
} from '@lucide/angular';
import { APP_CONFIG } from '../../core/config/app-config';
import { type Address, toInt } from '../../core/api/types';
import type { CheckoutStep } from './checkout-steps';
import { OrdersApi } from '../../core/api/orders-api';
import { UsersApi } from '../../core/api/users-api';
import { SessionStore } from '../../core/auth/session-store';
import { CartStore } from '../../core/cart/cart-store';
import { authErrorMessage } from '../auth/auth-errors';
import { CartLine } from '../../shared/ui/cart-line';
import { Field } from '../../shared/ui/field';
import { PhoneField } from '../../shared/ui/phone-field';
import { StreetAutocomplete } from '../../shared/ui/street-autocomplete';
import { DevFillButton } from '../../core/dev/dev-fill-button';
import type { DevData } from '../../core/dev/dev-fill';

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
    DevFillButton,
    LucideChevronLeft,
    LucideCreditCard,
    LucideDynamicIcon,
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
  /**
   * One signal per field of the address contract — see ShippingAddressSnapshot
   * in services/orders. `country` has NO input: it is DERIVED, never typed.
   */
  protected readonly street = signal('');
  protected readonly line2 = signal('');
  protected readonly city = signal('');
  protected readonly state = signal('');
  protected readonly postalCode = signal('');
  protected readonly phoneInput = signal('');

  /**
   * The plain card form's fields.
   *
   * CONTRACT: Local state only — nothing submits these. There is no payment
   * backend, and the Stripe path renders no fields at all because Stripe's own
   * element would own them. They exist so the dev fill can populate a form a
   * developer is looking at. See [[2026-09-07-dev-form-autofill]]
   */
  protected readonly cardNumber = signal('');
  protected readonly cardExpiry = signal('');
  protected readonly cardCvc = signal('');
  protected readonly savingAddress = signal(false);
  protected readonly addressError = signal<string | null>(null);

  /**
   * True while the buyer is correcting an address they already have. Users
   * stores exactly ONE address per profile (`address Json?`, no addresses
   * table), so this reveals the same form over the same field rather than
   * offering to add a second one.
   */
  protected readonly editingAddress = signal(false);

  /**
   * CONTRACT: The form is shown when there is no address OR while editing one.
   * Deriving the branch from `address()` alone re-renders the saved card the
   * instant edit mode opens, leaving the buyer no way to change it.
   */
  protected readonly showAddressForm = computed(
    () => this.address() === null || this.editingAddress(),
  );

  /** The saved address only while the card — not the form — is on show. */
  protected readonly savedAddressOnShow = computed<Address | null>(() =>
    this.showAddressForm() ? null : this.address(),
  );

  /**
   * CONTRACT: Exactly one step is `current` and none is `complete` before its
   * information exists. Cart is complete because the buyer reached this page
   * with payable lines; Payment stays `upcoming` until an address is on file,
   * mirroring the `canPay` rule rather than restating it.
   */
  protected readonly steps = computed<CheckoutStep[]>(() => {
    const hasAddress = this.address() !== null;
    return [
      { label: 'Cart', state: 'complete', icon: 'check' },
      {
        label: 'Address',
        state: hasAddress ? 'complete' : 'current',
        icon: hasAddress ? 'check' : 'map-pin',
      },
      {
        label: 'Payment',
        state: hasAddress ? 'current' : 'upcoming',
        icon: 'credit-card',
      },
    ];
  });

  /**
   * CONTRACT: What a suggestion resolved, kept so `country` survives — it is the
   * one contract field with no input, and the visible fields cannot carry it.
   * Null while the buyer types freehand, which is why `country` is then ''.
   */
  protected readonly resolvedAddress = signal<Address | null>(null);

  /**
   * The phone flag's pre-typing default only. Once a digit is typed the NUMBER
   * decides the country, so this never overrides what the buyer entered.
   */
  protected readonly seedCountry = computed(() => this.address()?.country ?? 'DO');

  protected readonly canSaveAddress = computed(
    () =>
      this.street().trim() !== '' &&
      this.city().trim() !== '' &&
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
   * Dev-only: fills the address form. `resolvedAddress` stays null on purpose —
   * the generated city and postal code go through the same heuristic parse a
   * hand-typed address does, so this exercises the real path.
   * See dev-fill.ts
   */
  protected devFill(data: DevData): void {
    this.street.set(data.street);
    const [devCity, devPostal] = data.cityAndPostalCode.split(',').map((part) => part.trim());
    this.line2.set(data.apartment);
    this.city.set(devCity ?? '');
    this.state.set(data.state);
    this.postalCode.set(devPostal ?? '');
    this.phoneInput.set(data.phoneNumber);
    // The card fields render only on the plain path; setting them when Stripe
    // is enabled is a harmless no-op rather than a branch to keep in sync.
    this.cardNumber.set(data.cardNumber);
    this.cardExpiry.set(data.cardExpiry);
    this.cardCvc.set(data.cardCvc);
  }

  /**
   * CONTRACT: Seed `resolvedAddress` as NULL — the buyer has picked no
   * suggestion, so a plain edit takes the same heuristic parse a typed address
   * does. The city/postal join mirrors onAddressSuggested(); splitting it any
   * other way re-saves an untouched form as city "Santo Domingo 10604".
   */
  protected startEditingAddress(): void {
    const saved = this.address();
    if (!saved) return;

    this.resolvedAddress.set(null);
    this.addressError.set(null);
    this.street.set(saved.line1);
    this.line2.set(saved.line2 ?? '');
    this.city.set(saved.city);
    this.state.set(saved.state);
    this.postalCode.set(saved.postalCode);
    this.phoneInput.set(this.phoneNumber() ?? '');
    this.editingAddress.set(true);
  }

  /**
   * Leaves edit mode without writing. The saved address is untouched because
   * nothing was sent — the form fields are scratch state, not the address.
   */
  protected cancelEditingAddress(): void {
    this.editingAddress.set(false);
    this.addressError.set(null);
    this.resolvedAddress.set(null);
  }

  /**
   * CONTRACT: Store the SessionStore user the response carries, not a locally
   * assembled one. PATCH /users/me answers with the whole profile, and the card
   * re-renders off the session — assembling it here would drift from whatever
   * the service normalised. One PATCH covers add and edit alike.
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
      this.editingAddress.set(false);
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
    this.city.set(address.city);
    this.state.set(address.state);
    this.postalCode.set(address.postalCode);
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
   * CONTRACT: Hand-editing any field a suggestion resolved DROPS the resolution.
   * Keeping it saves the suggestion's value while the buyer looks at the one
   * they just corrected, and keeps its `country` for a different address.
   */
  protected onResolvedFieldTyped(field: WritableSignal<string>, value: string): void {
    this.resolvedAddress.set(null);
    field.set(value);
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

    // CONTRACT: `country` is '' when no suggestion resolved one, NEVER a guess.
    // A default of 'DO' stores every hand-typed foreign address as Dominican.
    // The form has no country input by design: the autocomplete knows it.
    return {
      line1: this.street().trim(),
      line2: this.line2().trim() || null,
      city: this.city().trim(),
      state: this.state().trim(),
      postalCode: this.postalCode().trim(),
      country: '',
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
