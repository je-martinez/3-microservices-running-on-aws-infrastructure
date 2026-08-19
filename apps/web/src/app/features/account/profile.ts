import { Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { LucideLock } from '@lucide/angular';
import { AppHeader } from '../../core/layout/app-header';
import { OverlayStore } from '../../core/overlay/overlay-store';
import { NOTIFICATIONS } from '../../fixtures/notifications.fixture';
import { CURRENT_USER } from '../../fixtures/user.fixture';
import { formatMonthYear } from '../../shared/date/format-date';
import { ButtonPrimary } from '../../shared/ui/button-primary';
import { Field } from '../../shared/ui/field';

/**
 * Design: `Profile` (`hZ87b`, 1440 desktop / `nyVEI`, mobile).
 *
 * `User.address` is `anyOf: [{}, null]` in services/users/openapi.yaml —
 * completely untyped on the wire (see api-types.ts's `Address` comment).
 * The `Address` interface, and every field this screen shows for it, is
 * DESIGN-derived, not contract-derived: phase 2 must reconcile it with
 * whatever shape the backend settles on before this screen can write back.
 *
 * Fields render read-only-looking `Field` boxes pre-filled from
 * `CURRENT_USER` (no profile store exists yet); Save/Cancel are
 * presentational, matching the design's affordance without a backing
 * mutation.
 */
@Component({
  selector: 'app-profile',
  imports: [AppHeader, ButtonPrimary, Field, LucideLock],
  templateUrl: './profile.html',
})
export class ProfilePage {
  private readonly router = inject(Router);
  protected readonly overlay = inject(OverlayStore);

  protected readonly user = CURRENT_USER;
  protected readonly hasUnreadNotifications = NOTIFICATIONS.some((n) => !n.read);

  protected readonly initials = computed(() =>
    this.user.fullName
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
  protected readonly memberSinceLabel = computed(
    () => `Member since ${formatMonthYear(this.user.createdAt)}`,
  );

  // NOT from a contract — see this class's comment. Address is null in
  // theory (the design has no "no address" state for Profile, unlike
  // CartDrawer), so an empty string is the only reasonable fallback.
  protected readonly addressLine = computed(() => {
    const address = this.user.address;
    if (!address) return '';
    const line2 = address.line2 ? `, ${address.line2}` : '';
    return `${address.line1}${line2}, ${address.city} ${address.postalCode}, ${address.country}`;
  });

  protected goTo(path: string): void {
    void this.router.navigateByUrl(path);
  }
}
