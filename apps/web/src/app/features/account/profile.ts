import { Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { LucideLock } from '@lucide/angular';
import { AppHeader } from '../../core/layout/app-header';
import { OverlayStore } from '../../core/overlay/overlay-store';
import { NOTIFICATIONS } from '../../fixtures/notifications.fixture';
import { CURRENT_USER } from '../../fixtures/user.fixture';
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
  template: `
    <div class="bg-surface-body flex h-fit min-h-screen w-full flex-col items-start justify-start gap-0">
      <app-app-header
        [hasUnreadNotifications]="hasUnreadNotifications"
        (notificationsClicked)="overlay.openNotifications()"
        (profileClicked)="overlay.openAccountMenu()"
        (cartClicked)="goTo('/')"
      />

      <div class="flex w-full flex-1 flex-col items-center justify-start gap-0 p-5 md:p-11">
        <div class="flex h-fit w-full max-w-[760px] shrink-0 flex-col items-start justify-start gap-5 md:gap-[26px]">
          <div class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-[3px] md:gap-[6px]">
            <h1 class="text-ink-primary text-2xl font-bold tracking-[-0.5px] md:text-[30px] md:tracking-[-0.8px]">
              Profile
            </h1>
            <p class="text-ink-secondary text-[13px] md:text-[15px]">
              Update your name, delivery address and phone number.
            </p>
          </div>

          <div class="border-line bg-surface-white flex h-fit w-full shrink-0 flex-row items-center justify-start gap-4 rounded-xl border p-5">
            <div class="bg-brand-navy flex h-14 w-14 shrink-0 flex-row items-center justify-center rounded-full">
              <span class="text-surface-white text-lg font-bold">{{ initials() }}</span>
            </div>
            <div class="flex h-fit flex-1 flex-col items-start justify-start gap-[3px]">
              <span class="text-ink-primary text-[16.5px] font-semibold">{{ user.fullName }}</span>
              <span class="flex h-fit w-fit shrink-0 flex-row items-center justify-start gap-[7px]">
                <svg lucideLock class="text-ink-muted h-[13px] w-[13px]"></svg>
                <span class="text-ink-secondary text-[13.5px]">{{ user.email }} · sign-in email, can't be changed</span>
              </span>
            </div>
            <span class="bg-surface-subtle flex h-[30px] w-fit shrink-0 flex-row items-center justify-center rounded-full px-[13px]">
              <span class="text-ink-secondary text-[12.5px] whitespace-nowrap">{{ memberSinceLabel() }}</span>
            </span>
          </div>

          <div class="border-line bg-surface-white flex h-fit w-full shrink-0 flex-col items-start justify-start gap-4 rounded-xl border p-5 md:p-6">
            <span class="text-ink-muted text-xs font-semibold tracking-[1.5px]">PERSONAL DETAILS</span>
            <div class="flex h-fit w-full shrink-0 flex-col items-start justify-start gap-4 md:flex-row">
              <div class="w-full flex-1">
                <app-field label="Full name" icon="user" [value]="user.fullName" />
              </div>
              <div class="w-full flex-1">
                <app-field label="Phone number" icon="phone" type="text" [value]="user.phoneNumber ?? ''" />
              </div>
            </div>
          </div>

          <div class="border-line bg-surface-white flex h-fit w-full shrink-0 flex-col items-start justify-start gap-4 rounded-xl border p-5 md:p-6">
            <span class="text-ink-muted text-xs font-semibold tracking-[1.5px]">DELIVERY ADDRESS</span>
            <app-field label="Address" icon="map-pin" [value]="addressLine()" help="Used as the default delivery address at checkout." />
          </div>

          <div class="flex h-fit w-full shrink-0 flex-row items-center justify-end gap-3">
            <button
              type="button"
              class="h-field border-line-strong text-brand-navy flex w-[140px] shrink-0 flex-row items-center justify-center rounded-md border text-base font-semibold"
              (click)="goTo('/')"
            >
              Cancel
            </button>
            <div class="w-[190px]">
              <app-button-primary label="Save changes" />
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
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

  protected readonly memberSinceLabel = computed(() => {
    const date = new Date(this.user.createdAt);
    return `Member since ${date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
  });

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
