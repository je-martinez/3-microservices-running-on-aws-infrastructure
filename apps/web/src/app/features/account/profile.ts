import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { form, maxLength, pattern, required, FormField } from '@angular/forms/signals';
import { Router } from '@angular/router';
import {
  LucideCircleCheck,
  LucideLock,
  LucideRefreshCw,
  LucideTriangleAlert,
  LucideX,
} from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import type { Address, User } from '../../core/api/types';
import { APP_CONFIG } from '../../core/config/app-config';
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
import { PaymentMethodsTab } from './payment-methods-tab';

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

/** The form as a saved profile seeds it — what Cancel and a successful save restore. */
function formFromUser(user: User): ProfileForm {
  return {
    fullName: user.fullName,
    phoneNumber: user.phoneNumber ?? '',
    street: user.address?.line1 ?? '',
    line2: user.address?.line2 ?? '',
    city: user.address?.city ?? '',
    state: user.address?.state ?? '',
    postalCode: user.address?.postalCode ?? '',
  };
}

/**
 * WHY 6000: "Changes saved" plus an eight-word line is about 2-3 seconds of
 * reading at ~200 wpm; the rest is the time to notice the banner appeared.
 * Toast guidance floors auto-dismissal around 5s for a message with no action.
 */
export const SAVED_BANNER_DISMISS_MS = 6000;

function sameForm(a: ProfileForm, b: ProfileForm): boolean {
  return (Object.keys(a) as (keyof ProfileForm)[]).every((key) => a[key] === b[key]);
}

/**
 * Design: `Profile` (`hZ87b`, 1440 / `nyVEI`, 390).
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
    NgTemplateOutlet,
    PaymentMethodsTab,
    PhoneField,
    StreetAutocomplete,
    LucideCircleCheck,
    LucideLock,
    LucideRefreshCw,
    LucideTriangleAlert,
    LucideX,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './profile.html',
})
export class ProfilePage {
  private readonly router = inject(Router);
  private readonly usersApi = inject(UsersApi);
  private readonly session = inject(SessionStore);
  private readonly injector = inject(Injector);

  /** The banner's live region plus the Save/Cancel row it sits above. */
  private readonly saveFooter = viewChild<ElementRef<HTMLElement>>('saveFooter');

  protected readonly user = this.session.user;

  /**
   * CONTRACT: The tab mounts only behind this flag — with STRIPE_ENABLED off the
   * profile keeps its pre-milestone single-view shape (no Tabs frame, no SAVED
   * CARDS section). This is the same kill switch that governs the checkout
   * branch and the Users routes, not a second flag.
   * See [[2026-09-19-stripe-payments-design]]
   */
  protected readonly stripeEnabled = computed(() => APP_CONFIG.stripeEnabled);
  /** Only a first load blanks the screen; a refresh keeps the stale profile up. */
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);

  /**
   * The form values the last successful save produced; non-null shows the
   * "Changes saved" banner. Any edit that moves the model off them clears it.
   */
  private readonly savedForm = signal<ProfileForm | null>(null);
  protected readonly showSaved = computed(() => this.savedForm() !== null);

  /**
   * CONTRACT: Hover and keyboard focus pause the dismiss countdown independently
   * (WCAG 2.2.1), so leaving with the mouse while the X still holds focus keeps
   * it paused. Both reset on every hide: a banner removed under a resting
   * pointer never fires `mouseleave`, and the next one would never auto-hide.
   */
  private bannerHovered = false;
  private bannerFocused = false;
  private bannerTimer: ReturnType<typeof setTimeout> | null = null;
  /** Milliseconds left on the countdown; a resume continues from here. */
  private bannerRemaining = SAVED_BANNER_DISMISS_MS;
  private bannerStartedAt = 0;

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
    // CONTRACT: Clear on a value DIFFERENCE, never on any model write. The
    // reseed after a save writes an equal model, and clearing on the write
    // itself hides the banner in the same tick it appears.
    effect(() => {
      const current = this.model();
      const saved = untracked(this.savedForm);
      if (saved !== null && !sameForm(saved, current)) this.dismissSaved();
    });
    inject(DestroyRef).onDestroy(() => this.stopBannerTimer());
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
    this.model.set(formFromUser(current));
  }

  /** Cancel: an equal reseed would leave the banner up, so it is dismissed explicitly. */
  protected discardEdits(): void {
    this.dismissSaved();
    this.resetForm();
  }

  /** CONTRACT: The ONLY hide path — anything else leaves a stray timer running. */
  protected dismissSaved(): void {
    this.stopBannerTimer();
    this.bannerHovered = false;
    this.bannerFocused = false;
    this.bannerRemaining = SAVED_BANNER_DISMISS_MS;
    this.savedForm.set(null);
  }

  private showSavedBanner(saved: ProfileForm): void {
    this.dismissSaved();
    this.savedForm.set(saved);
    this.armBannerTimer();
    afterNextRender(() => this.revealSaveFooter(), { injector: this.injector });
  }

  /**
   * CONTRACT: Scroll `.app-scroll` to its end — AppLayout's column, since the
   * window never scrolls under that layout. Run only AFTER the banner renders
   * and only on show: measured earlier, the height lacks the banner and "Save
   * changes" stays pushed below the fold.
   */
  private revealSaveFooter(): void {
    const footer = this.saveFooter()?.nativeElement;
    const container = footer?.closest('.app-scroll') ?? footer?.ownerDocument.documentElement;
    // WHY: jsdom implements neither `Element.scrollTo` nor `matchMedia`.
    if (typeof container?.scrollTo !== 'function') return;
    const reduced =
      typeof globalThis.matchMedia === 'function' &&
      globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
    container.scrollTo({ top: container.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
  }

  protected onBannerHover(hovered: boolean): void {
    this.bannerHovered = hovered;
    this.syncBannerTimer();
  }

  /** Focus moving between elements INSIDE the banner is not a blur. */
  protected onBannerFocus(event: FocusEvent, focused: boolean): void {
    const banner = event.currentTarget as HTMLElement;
    if (!focused && banner.contains(event.relatedTarget as Node | null)) return;
    this.bannerFocused = focused;
    this.syncBannerTimer();
  }

  /** Pauses while held; a resume continues the banked remainder, not a fresh 6s. */
  private syncBannerTimer(): void {
    if (!this.showSaved()) return;
    if (this.bannerHovered || this.bannerFocused) {
      if (this.bannerTimer === null) return;
      this.stopBannerTimer();
      this.bannerRemaining = Math.max(0, this.bannerRemaining - (Date.now() - this.bannerStartedAt));
    } else if (this.bannerTimer === null) {
      this.armBannerTimer();
    }
  }

  private armBannerTimer(): void {
    this.bannerStartedAt = Date.now();
    this.bannerTimer = setTimeout(() => this.dismissSaved(), this.bannerRemaining);
  }

  private stopBannerTimer(): void {
    if (this.bannerTimer !== null) clearTimeout(this.bannerTimer);
    this.bannerTimer = null;
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
    this.dismissSaved();
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
      // WHY: Reseed before recording the save, so the clearing effect compares
      // the banner's values against an equal model rather than the raw input.
      const savedForm = formFromUser(updated);
      this.model.set(savedForm);
      this.showSavedBanner(savedForm);
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
