import { Component, computed, inject, signal } from '@angular/core';
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
  imports: [ButtonPrimary, Field, PhoneField, LucideLock, LucideRefreshCw, LucideTriangleAlert],
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

  constructor() {
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

  // NOT from a contract — see this class's comment. Address is null in
  // theory (the design has no "no address" state for Profile, unlike
  // CartDrawer), so an empty string is the only reasonable fallback.
  protected readonly addressLine = computed(() => {
    const address = this.user()?.address;
    if (!address) return '';
    const line2 = address.line2 ? `, ${address.line2}` : '';
    return `${address.line1}${line2}, ${address.city} ${address.postalCode}, ${address.country}`;
  });

  /** The flag's pre-typing default; a typed number overrides it. */
  protected readonly seedCountry = computed(() => this.user()?.address?.country ?? undefined);

  protected goTo(path: string): void {
    void this.router.navigateByUrl(path);
  }
}
