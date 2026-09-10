import {
  Component,
  computed,
  effect,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { form, maxLength, pattern, required, FormField } from '@angular/forms/signals';
import { Router } from '@angular/router';
import { LucideLock, LucideRefreshCw, LucideTriangleAlert } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import type { Address } from '../../core/api/types';
import { UsersApi } from '../../core/api/users-api';
import { SessionStore } from '../../core/auth/session-store';
import { authErrorMessage } from '../auth/auth-errors';
import { formatMonthYear } from '../../shared/date/format-date';
import { ButtonPrimary } from '../../shared/ui/button-primary';
import { Field } from '../../shared/ui/field';
import { StreetAutocomplete } from '../../shared/ui/street-autocomplete';
import { PhoneField } from '../../shared/ui/phone-field';
import { DevFillButton } from '../../core/dev/dev-fill-button';
import type { DevData } from '../../core/dev/dev-fill';

/** Every editable field of the two cards, minus `country` — see the class doc. */
interface ProfileForm {
  fullName: string;
  phoneNumber: string;
  street: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
}

const EMPTY_PROFILE_FORM: ProfileForm = {
  fullName: '',
  phoneNumber: '',
  street: '',
  line2: '',
  city: '',
  state: '',
  postalCode: '',
};

/**
 * Design: `Profile` (`hZ87b`, 1440 / `nyVEI`, 390). Save/Cancel are
 * presentational, with no backing mutation.
 *
 * CONTRACT: The address fields are DESIGN-derived — `User.address` is
 * `anyOf: [{}, null]` in services/users/openapi.yaml, so a write-back before
 * that shape is reconciled sends a payload the backend never agreed to.
 * See [[openapi-specs]]
 */
@Component({
  selector: 'app-profile',
  imports: [
    ButtonPrimary,
    DevFillButton,
    Field,
    FormField,
    PhoneField,
    StreetAutocomplete,
    LucideLock,
    LucideRefreshCw,
    LucideTriangleAlert,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './profile.html',
})
export class ProfilePage {
  private readonly router = inject(Router);
  private readonly usersApi = inject(UsersApi);
  private readonly session = inject(SessionStore);

  protected readonly user = this.session.user;
  /** Only a first load blanks the screen; a refresh keeps the stale profile up. */
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);

  /**
   * One model for the whole screen, over the design's two sections.
   * CONTRACT: `country` is NOT a field here, as at checkout — the autocomplete
   * resolves it, so this form preserves the saved value rather than guessing.
   */
  protected readonly model = signal<ProfileForm>(EMPTY_PROFILE_FORM);

  /**
   * CONTRACT: `required` alone accepts a value of spaces — it rejects only the
   * empty string — so the pattern is what keeps "   " from being saved as a
   * name. Dropping it re-enables saving a profile with a blank `fullName`.
   *
   * CONTRACT: The ZIP's 5-digit cap belongs HERE, not on the template's
   * `app-field`. `[formField]` owns `maxLength` as a control binding and the
   * compiler rejects binding it alongside (NG8022); the schema is what reaches
   * the input's `maxlength` and the numeric truncation.
   * See [[angular-component-authoring]]
   */
  protected readonly profileForm = form(this.model, (path) => {
    required(path.fullName, { message: 'Enter your full name' });
    pattern(path.fullName, /\S/, { message: 'Enter your full name' });
    maxLength(path.postalCode, 5);
  });

  constructor() {
    // CONTRACT: Seed the form from whatever the session already holds, then
    // again once the fetch lands. Seeding only on load leaves every field blank
    // for a user who arrives with a cached profile, which reads as data loss.
    effect(() => {
      const current = this.user();
      if (current !== null && !this.saving()) this.resetForm();
    });
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(this.session.user() === null);
    this.error.set(null);
    try {
      this.session.setUser(await firstValueFrom(this.usersApi.me()));
    } catch (error: unknown) {
      this.error.set(authErrorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * One filler per SECTION, not one for the form. The two cards are edited
   * independently, so a single button would overwrite the section the user is
   * not looking at. Both draw from the same session data, so the name and the
   * address still describe one plausible person. See dev-fill.ts
   */
  protected devFillPersonal(data: DevData): void {
    this.model.update((current) => ({
      ...current,
      fullName: data.fullName,
      phoneNumber: data.phoneNumber,
    }));
  }

  /**
   * CONTRACT: What a suggestion resolved, kept so `country` survives the save —
   * it is the one contract field this form has no input for. Null while the
   * user types freehand, which is why the saved country is preserved then.
   */
  protected readonly resolvedAddress = signal<Address | null>(null);

  /**
   * CONTRACT: Mirror the resolved city, state and postal code into the VISIBLE
   * fields as well as into `resolvedAddress`. A value saved but never shown is
   * one the user cannot correct.
   */
  protected onAddressSuggested(address: Address): void {
    this.resolvedAddress.set(address);
    this.model.update((current) => ({
      ...current,
      street: address.line1,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
    }));
  }

  /**
   * CONTRACT: Editing the street KEEPS the resolution — appending a house number
   * is the expected next action, since no Dominican suggestion carries one. Only
   * clearing it starts over.
   */
  protected onStreetTyped(value: string): void {
    if (value.trim() === '') this.resolvedAddress.set(null);
  }

  /** @see devFillPersonal */
  protected devFillAddress(data: DevData): void {
    const [devCity, devPostal] = data.cityAndPostalCode.split(',').map((part) => part.trim());
    this.model.update((current) => ({
      ...current,
      street: data.street,
      line2: data.apartment,
      city: devCity ?? '',
      state: data.state,
      postalCode: devPostal ?? '',
    }));
  }

  /** Discards edits by re-seeding every field from the saved profile. */
  protected resetForm(): void {
    const current = this.user();
    if (!current) return;

    this.saveError.set(null);
    this.model.set({
      fullName: current.fullName,
      phoneNumber: current.phoneNumber ?? '',
      street: current.address?.line1 ?? '',
      line2: current.address?.line2 ?? '',
      city: current.address?.city ?? '',
      state: current.address?.state ?? '',
      postalCode: current.address?.postalCode ?? '',
    });
  }

  protected readonly canSave = computed(() => this.profileForm().valid() && !this.saving());

  /**
   * CONTRACT: Send the address only when a street is present. Orders drops an
   * all-null snapshot to NULL (ShippingAddressSnapshot), so posting a blank one
   * erases a saved address the user never touched.
   */
  protected async save(): Promise<void> {
    // CONTRACT: Mark the fields touched before the validity gate, or a form
    // saved with an empty name renders no message at all — `Field` hides an
    // error until its field is touched.
    this.profileForm().markAsTouched();
    if (!this.canSave()) return;

    this.saving.set(true);
    this.saveError.set(null);
    const values = this.model();
    try {
      const phone = values.phoneNumber.trim();
      const updated = await firstValueFrom(
        this.usersApi.updateMe({
          fullName: values.fullName.trim(),
          ...(phone === '' ? {} : { phoneNumber: phone }),
          ...(values.street.trim() === ''
            ? {}
            : {
                address: {
                  line1: values.street.trim(),
                  line2: values.line2.trim() || null,
                  city: values.city.trim(),
                  state: values.state.trim(),
                  postalCode: values.postalCode.trim(),
                  // CONTRACT: A suggestion's country wins over the saved one —
                  // that is the only way moving abroad ever corrects it. With no
                  // suggestion the saved value is preserved, never guessed:
                  // this form has no country input.
                  country: this.resolvedAddress()?.country ?? this.user()?.address?.country ?? '',
                },
              }),
        }),
      );
      this.session.setUser(updated);
    } catch (error: unknown) {
      this.saveError.set(authErrorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected readonly initials = computed(() =>
    (this.user()?.fullName ?? '')
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join(''),
  );

  /**
   * `User.createdAt` is a bare `string` in services/users/openapi.yaml — no
   * `format: date-time` — so an unparseable value is reachable here, and
   * `formatMonthYear` degrades it rather than printing `Invalid Date`.
   */
  protected readonly memberSinceLabel = computed(() => {
    const createdAt = this.user()?.createdAt;
    return createdAt ? `Member since ${formatMonthYear(createdAt)}` : '';
  });

  /** The flag's pre-typing default; a typed number overrides it. */
  protected readonly seedCountry = computed(() => this.user()?.address?.country ?? undefined);

  protected goTo(path: string): void {
    void this.router.navigateByUrl(path);
  }
}
