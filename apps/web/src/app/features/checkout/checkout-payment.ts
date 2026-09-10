import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { form, maxLength, pattern, required, FormField } from '@angular/forms/signals';
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
import { digitsOnly, groupCardDigits } from '../../shared/ui/numeric-input';

/** The visible delivery-address fields; `country` is derived, never typed. */
interface AddressForm {
  street: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  phoneNumber: string;
}

/** The plain card fields, which nothing submits — see `cardForm`. */
interface CardForm {
  cardNumber: string;
  cardHolder: string;
  cardExpiry: string;
  cardCvc: string;
}

const EMPTY_ADDRESS_FORM: AddressForm = {
  street: '',
  line2: '',
  city: '',
  state: '',
  postalCode: '',
  phoneNumber: '',
};

const EMPTY_CARD_FORM: CardForm = {
  cardNumber: '',
  cardHolder: '',
  cardExpiry: '',
  cardCvc: '',
};

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
    FormField,
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
  changeDetection: ChangeDetectionStrategy.OnPush,
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

  /**
   * The delivery-address form, one model over the fields of the address
   * contract — see ShippingAddressSnapshot in services/orders.
   *
   * CONTRACT: `country` is NOT a field of this model: it is DERIVED from
   * `resolvedAddress`, never typed. Adding it here gives the buyer an input the
   * design has no frame for, and `parseAddress` would then save a guess.
   * See [[angular-component-authoring]]
   */
  protected readonly addressModel = signal<AddressForm>(EMPTY_ADDRESS_FORM);

  /**
   * CONTRACT: Street and city gate saving, and `required` alone accepts a value
   * of spaces — it rejects only the empty string — so each pairs with a pattern.
   * Without it a form of blanks saves an address that ships nowhere.
   *
   * CONTRACT: The ZIP's 5-digit cap belongs HERE, not on the template's
   * `app-field`. `[formField]` owns `maxLength` as a control binding and the
   * compiler rejects binding it alongside (NG8022); the schema is what reaches
   * the input's `maxlength` and the numeric truncation.
   * See [[angular-component-authoring]]
   */
  protected readonly addressForm = form(this.addressModel, (path) => {
    required(path.street, { message: 'Enter your street address' });
    pattern(path.street, /\S/, { message: 'Enter your street address' });
    required(path.city, { message: 'Enter your city' });
    pattern(path.city, /\S/, { message: 'Enter your city' });
    maxLength(path.postalCode, 5);
  });

  /**
   * CONTRACT: Local state only — nothing submits these, and the Stripe path
   * renders no fields at all. They exist so the dev fill can populate a form a
   * developer is looking at, which is why this form carries no validators.
   *
   * CONTRACT: Its inputs stay RAW `<input>`s driven by the handlers below, NOT
   * `[formField]` — the directive reads the element's raw value and would undo
   * the grouping applied on each keystroke, showing an unspaced
   * `4242424242424242`. See [[2026-09-07-dev-form-autofill]]
   */
  protected readonly cardModel = signal<CardForm>(EMPTY_CARD_FORM);
  protected readonly cardForm = form(this.cardModel);

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
    () => this.addressForm().valid() && !this.savingAddress(),
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
      this.cart.canCheckout() && !this.cart.saving() && !this.placing() && this.address() !== null,
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
    const [devCity, devPostal] = data.cityAndPostalCode.split(',').map((part) => part.trim());
    this.addressModel.set({
      street: data.street,
      line2: data.apartment,
      city: devCity ?? '',
      state: data.state,
      postalCode: devPostal ?? '',
      phoneNumber: data.phoneNumber,
    });
    // The card fields render only on the plain path; setting them when Stripe
    // is enabled is a harmless no-op rather than a branch to keep in sync.
    // CONTRACT: Fill through the same formatter typing uses, never the raw
    // generated digits — Stripe's test number arrives unspaced, and setting it
    // directly shows `4242424242424242` in a field whose maxlength is sized for
    // the grouped `4242 4242 4242 4242`.
    this.cardModel.set({
      cardNumber: groupCardDigits(data.cardNumber),
      cardHolder: data.fullName,
      cardExpiry: data.cardExpiry,
      cardCvc: data.cardCvc,
    });
  }

  protected onCardNumberInput(element: HTMLInputElement): void {
    const value = groupCardDigits(element.value);
    element.value = value;
    this.cardForm.cardNumber().value.set(value);
  }

  protected onCardExpiryInput(element: HTMLInputElement): void {
    const digits = digitsOnly(element.value, 4);
    const value = digits.length > 2 ? `${digits.slice(0, 2)} / ${digits.slice(2)}` : digits;
    element.value = value;
    this.cardForm.cardExpiry().value.set(value);
  }

  protected onCardCvcInput(element: HTMLInputElement): void {
    const value = digitsOnly(element.value, 4);
    element.value = value;
    this.cardForm.cardCvc().value.set(value);
  }

  protected onCardHolderInput(element: HTMLInputElement): void {
    this.cardForm.cardHolder().value.set(element.value);
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
    this.addressModel.set({
      street: saved.line1,
      line2: saved.line2 ?? '',
      city: saved.city,
      state: saved.state,
      postalCode: saved.postalCode,
      phoneNumber: this.phoneNumber() ?? '',
    });
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
    // CONTRACT: Mark the fields touched before the validity gate, or a save
    // attempted on a blank form renders no message at all — `Field` hides an
    // error until its field is touched.
    this.addressForm().markAsTouched();
    if (!this.canSaveAddress()) return;

    this.savingAddress.set(true);
    this.addressError.set(null);
    const phone = this.addressModel().phoneNumber.trim();
    try {
      const updated = await firstValueFrom(
        this.usersApi.updateMe({
          address: this.parseAddress(),
          ...(phone === '' ? {} : { phoneNumber: phone }),
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
    this.addressModel.update((current) => ({
      ...current,
      street: address.line1,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
    }));
  }

  /**
   * CONTRACT: Editing the street KEEPS the resolved city/state/postal code —
   * appending the house number is the expected next action, since no Dominican
   * suggestion carries one. Only clearing the street drops the resolution,
   * because a blank field means the buyer is starting over.
   */
  protected onStreetTyped(value: string): void {
    if (value.trim() === '') this.resolvedAddress.set(null);
  }

  /**
   * CONTRACT: Hand-editing any field a suggestion resolved DROPS the resolution.
   * Keeping it saves the suggestion's value while the buyer looks at the one
   * they just corrected, and keeps its `country` for a different address.
   *
   * CONTRACT: Bound as `(valueChange)` BESIDE `[formField]`, which writes the
   * value itself. The directive pushes a programmatic value through the model's
   * INPUT, which emits nothing — so only a buyer's keystroke reaches here, and
   * `onAddressSuggested` filling the same fields does not erase its own
   * resolution. See [[angular-component-authoring]]
   */
  protected onResolvedFieldTyped(): void {
    this.resolvedAddress.set(null);
  }

  /**
   * WHY: The design collects city and postal code in ONE field, while the API
   * stores them apart. A chosen suggestion knows them exactly, so its values
   * win; otherwise the last comma-separated part is the postal code when it
   * looks like one, and the code is left empty rather than guessed.
   */
  private parseAddress(): Address {
    const values = this.addressModel();
    const resolved = this.resolvedAddress();
    // The street still comes from the field: the buyer adds the house number
    // the suggestion has no data for.
    if (resolved) return { ...resolved, line1: values.street.trim() };

    // CONTRACT: `country` is '' when no suggestion resolved one, NEVER a guess.
    // A default of 'DO' stores every hand-typed foreign address as Dominican.
    // The form has no country input by design: the autocomplete knows it.
    return {
      line1: values.street.trim(),
      line2: values.line2.trim() || null,
      city: values.city.trim(),
      state: values.state.trim(),
      postalCode: values.postalCode.trim(),
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
      // CONTRACT: `justPlaced` rides in navigation state, NOT a query param, so
      // the success banner cannot be resurrected by sharing or bookmarking the
      // order URL. See [[angular-component-authoring]]
      await this.router.navigate(['/orders', order.id], { state: { justPlaced: true } });
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
