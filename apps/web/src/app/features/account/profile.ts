import { Component, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LucideLock, LucideRefreshCw, LucideTriangleAlert } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import { UsersApi } from '../../core/api/users-api';
import { SessionStore } from '../../core/auth/session-store';
import { authErrorMessage } from '../auth/auth-errors';
import { formatMonthYear } from '../../shared/date/format-date';
import { ButtonPrimary } from '../../shared/ui/button-primary';
import { Field } from '../../shared/ui/field';
import { PhoneField } from '../../shared/ui/phone-field';
import { DevFillButton } from '../../core/dev/dev-fill-button';
import type { DevData } from '../../core/dev/dev-fill';

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
  imports: [ButtonPrimary, DevFillButton, Field, PhoneField, LucideLock, LucideRefreshCw, LucideTriangleAlert],
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
   * One signal per editable field, per the design's two sections.
   * CONTRACT: `country` has no input, as at checkout — the autocomplete resolves
   * it, so this form preserves the saved value rather than guessing.
   */
  protected readonly fullName = signal('');
  protected readonly phoneInput = signal('');
  protected readonly street = signal('');
  protected readonly line2 = signal('');
  protected readonly city = signal('');
  protected readonly state = signal('');
  protected readonly postalCode = signal('');

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
    this.fullName.set(data.fullName);
    this.phoneInput.set(data.phoneNumber);
  }

  /** @see devFillPersonal */
  protected devFillAddress(data: DevData): void {
    this.street.set(data.street);
    this.line2.set(data.apartment);
    const [devCity, devPostal] = data.cityAndPostalCode.split(',').map((part) => part.trim());
    this.city.set(devCity ?? '');
    this.state.set(data.state);
    this.postalCode.set(devPostal ?? '');
  }

  /** Discards edits by re-seeding every field from the saved profile. */
  protected resetForm(): void {
    const current = this.user();
    if (!current) return;

    this.saveError.set(null);
    this.fullName.set(current.fullName);
    this.phoneInput.set(current.phoneNumber ?? '');
    this.street.set(current.address?.line1 ?? '');
    this.line2.set(current.address?.line2 ?? '');
    this.city.set(current.address?.city ?? '');
    this.state.set(current.address?.state ?? '');
    this.postalCode.set(current.address?.postalCode ?? '');
  }

  protected readonly canSave = computed(
    () => this.fullName().trim() !== '' && !this.saving(),
  );

  /**
   * CONTRACT: Send the address only when a street is present. Orders drops an
   * all-null snapshot to NULL (ShippingAddressSnapshot), so posting a blank one
   * erases a saved address the user never touched.
   */
  protected async save(): Promise<void> {
    if (!this.canSave()) return;

    this.saving.set(true);
    this.saveError.set(null);
    try {
      const phone = this.phoneInput().trim();
      const updated = await firstValueFrom(
        this.usersApi.updateMe({
          fullName: this.fullName().trim(),
          ...(phone === '' ? {} : { phoneNumber: phone }),
          ...(this.street().trim() === ''
            ? {}
            : {
                address: {
                  line1: this.street().trim(),
                  line2: this.line2().trim() || null,
                  city: this.city().trim(),
                  state: this.state().trim(),
                  postalCode: this.postalCode().trim(),
                  // Preserved, never guessed — this form has no country input.
                  country: this.user()?.address?.country ?? '',
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
