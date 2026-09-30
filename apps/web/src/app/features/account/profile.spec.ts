import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import {
  LucideApple,
  LucideCheck,
  LucideCreditCard,
  LucideLink,
  LucideTrash2,
  provideLucideIcons,
} from '@lucide/angular';
import { of } from 'rxjs';
import type { Stripe, StripeElements } from '@stripe/stripe-js';

import { ProfilePage } from './profile';
import { APP_CONFIG } from '../../core/config/app-config';
import { PaymentMethodsApi } from '../../core/api/payment-methods-api';
import { StripeLoader } from '../../core/payments/stripe-loader';
import { SessionStore } from '../../core/auth/session-store';
import { StreetAutocomplete } from '../../shared/ui/street-autocomplete';
import { awaitRequest, fillField, settle, textOf, USER } from '../auth/testing';

import { SCREEN_TEST_ICONS, SCREEN_TEST_PROVIDERS } from '../../shared/testing/fixtures';

/** A Stripe stub whose Payment Element mounts without an iframe. */
function fakeStripe(): Stripe {
  const element = { mount: () => undefined, unmount: () => undefined, on: () => element };
  const elements = { create: () => element, getElement: () => element } as unknown as StripeElements;
  return {
    elements: () => elements,
    confirmSetup: vi.fn().mockResolvedValue({ setupIntent: { payment_method: 'pm_new' } }),
  } as unknown as Stripe;
}

const ME = '/v1/users/me';

const MORGAN = {
  ...USER,
  fullName: 'Morgan Reyes',
  email: 'morgan.reyes@example.com',
  phoneNumber: '+1-503-555-0142',
  address: {
    line1: '482 Birch Hollow Lane',
    line2: 'Unit 3B',
    city: 'Portland',
    state: 'OR',
    postalCode: '97201',
    country: 'US',
  },
};

describe('ProfilePage', () => {
  let fixture: ComponentFixture<ProfilePage>;
  let controller: HttpTestingController;

  const STRIPE_ENABLED = APP_CONFIG.stripeEnabled;

  /**
   * CONTRACT: Restore this in `afterEach`. APP_CONFIG is a module-level const
   * shared by every spec in the run, so a redefinition left in place leaks the
   * flag into unrelated files — which then pass or fail by test ORDER.
   */
  function withStripeEnabled(enabled: boolean): void {
    Object.defineProperty(APP_CONFIG, 'stripeEnabled', {
      value: enabled,
      configurable: true,
      writable: false,
    });
  }

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        ...SCREEN_TEST_PROVIDERS,
        // CONTRACT: Merge into ONE provideLucideIcons call, never add a second.
        // It is a plain `useValue` over a single token, so a later call REPLACES
        // the registry — the symptom is "Unable to resolve icon 'map-pin'" from a
        // screen whose own icons this file never touched.
        provideLucideIcons(
          ...SCREEN_TEST_ICONS,
          LucideApple,
          LucideCheck,
          LucideCreditCard,
          LucideLink,
          LucideTrash2,
        ),
        // Inert while `stripeEnabled` is false — the tab renders nothing that
        // injects either, so the single-view tests are unaffected.
        {
          provide: PaymentMethodsApi,
          useValue: {
            list: () => of([]),
            createSetupIntent: () => of({ clientSecret: 'seti_1_secret_abc' }),
            attach: () => of({ id: 'pm_new' }),
            remove: () => of(undefined),
            setDefault: () => of(undefined),
          },
        },
        { provide: StripeLoader, useValue: { load: () => Promise.resolve(fakeStripe()) } },
      ],
    });
    await TestBed.compileComponents();
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    withStripeEnabled(STRIPE_ENABLED);
    controller.verify({ ignoreCancelled: true });
    TestBed.resetTestingModule();
  });

  /** Every `app-field` input's value — where Field puts its content. */
  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function fieldValues(): string[] {
    const root = fixture.nativeElement as HTMLElement;
    // The address field is an app-street-autocomplete, the rest are app-field.
    const controls = 'app-field input, app-street-autocomplete input';
    return Array.from(root.querySelectorAll(controls)).map((i) => (i as HTMLInputElement).value);
  }

  function create(): void {
    fixture = TestBed.createComponent(ProfilePage);
    fixture.detectChanges();
  }

  it('renders a loading state when the store is still empty', () => {
    create();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(root.querySelector('app-field')).toBeNull();

    controller.expectOne(ME).flush(USER);
  });

  it('renders the profile from /v1/users/me', async () => {
    create();
    const request = await awaitRequest(fixture, controller, ME);
    expect(request.request.method).toBe('GET');
    request.flush(MORGAN);
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Morgan Reyes');
    expect(root.textContent).toContain('morgan.reyes@example.com');
    expect(root.querySelector('[aria-busy="true"]')).toBeNull();
    // WHY: a Field renders its value into `<input value>`, which textContent
    // never sees — asserting on text alone passes against an empty form.
    expect(fieldValues()).toContain('Morgan Reyes');
    expect(fieldValues().join(' ')).toContain('482 Birch Hollow Lane');
  });

  /**
   * CONTRACT: One input per address field, minus `country` — the design gives it
   * no frame. Seeding every field is what makes this a form, not a summary.
   */
  it('seeds every address field from the saved profile', async () => {
    create();
    (await awaitRequest(fixture, controller, ME)).flush(MORGAN);
    await settle(fixture);

    expect(fieldValues()).toEqual([
      'Morgan Reyes',
      '482 Birch Hollow Lane',
      'Unit 3B',
      'Portland',
      'OR',
      '97201',
    ]);
  });

  it('saves every edited field to /v1/users/me', async () => {
    create();
    (await awaitRequest(fixture, controller, ME)).flush(MORGAN);
    await settle(fixture);

    fillField(fixture, 'City', 'Salem');
    fillField(fixture, 'ZIP Code', '97301');
    root().querySelector<HTMLButtonElement>('app-button-primary button')?.click();
    await settle(fixture);

    const patch = await awaitRequest(fixture, controller, ME);
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({
      fullName: 'Morgan Reyes',
      phoneNumber: '+1-503-555-0142',
      address: {
        line1: '482 Birch Hollow Lane',
        line2: 'Unit 3B',
        city: 'Salem',
        state: 'OR',
        postalCode: '97301',
        // CONTRACT: PRESERVED, never guessed. This form has no country input,
        // so a saved country must survive an edit to any other field.
        country: 'US',
      },
    });
    patch.flush(MORGAN);
    await settle(fixture);
  });

  /**
   * CONTRACT: A suggestion's country REPLACES the saved one. The form has no
   * country input, so this is the only way a user who moved abroad ever
   * corrects it — preserving the old value would save a Spanish street as US.
   */
  it('saves the country a suggestion resolved, over the stored one', async () => {
    create();
    (await awaitRequest(fixture, controller, ME)).flush(MORGAN);
    await settle(fixture);

    fixture.debugElement
      .query(By.directive(StreetAutocomplete))
      .componentInstance.addressSelected.emit({
        line1: 'Gran Via 1',
        line2: null,
        city: 'Madrid',
        state: 'Madrid',
        postalCode: '28013',
        country: 'ES',
      });
    await settle(fixture);

    root().querySelector<HTMLButtonElement>('app-button-primary button')?.click();
    await settle(fixture);

    const patch = await awaitRequest(fixture, controller, ME);
    expect(patch.request.body).toMatchObject({
      address: { line1: 'Gran Via 1', city: 'Madrid', country: 'ES' },
    });
    patch.flush(MORGAN);
    await settle(fixture);
  });

  /**
   * CONTRACT: Orders drops an all-null address snapshot to NULL, so posting a
   * blank address erases one the user never touched. No street, no address key.
   */
  it('omits the address entirely when the street is cleared', async () => {
    create();
    (await awaitRequest(fixture, controller, ME)).flush(MORGAN);
    await settle(fixture);

    fillField(fixture, 'Address Line 1', '');
    root().querySelector<HTMLButtonElement>('app-button-primary button')?.click();
    await settle(fixture);

    const patch = await awaitRequest(fixture, controller, ME);
    expect(patch.request.body).not.toHaveProperty('address');
    patch.flush(MORGAN);
    await settle(fixture);
  });

  /**
   * CONTRACT: A name of spaces is not a name. `required` on its own rejects only
   * the empty string, so without the pattern beside it a profile saves with a
   * blank `fullName` and the account renders with no name anywhere.
   */
  it('refuses to save a full name that is blank or only spaces', async () => {
    create();
    (await awaitRequest(fixture, controller, ME)).flush(MORGAN);
    await settle(fixture);

    const saveButton = () => root().querySelector<HTMLButtonElement>('app-button-primary button');
    expect(saveButton()?.disabled).toBe(false);

    fillField(fixture, 'Full name', '');
    expect(saveButton()?.disabled).toBe(true);

    fillField(fixture, 'Full name', '   ');
    expect(saveButton()?.disabled).toBe(true);

    fillField(fixture, 'Full name', 'Morgan Reyes');
    expect(saveButton()?.disabled).toBe(false);

    controller.verify();
  });

  it('discards edits when Cancel is pressed', async () => {
    create();
    (await awaitRequest(fixture, controller, ME)).flush(MORGAN);
    await settle(fixture);

    fillField(fixture, 'City', 'Salem');
    expect(fieldValues()).toContain('Salem');

    Array.from(root().querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Cancel')
      ?.click();
    await settle(fixture);

    expect(fieldValues()).toContain('Portland');
    controller.verify();
  });

  /**
   * The profile's own round trip: the stored number reaches the field and its
   * country is derived on render, before any typing.
   */
  it('renders the phone number in a phone field flagged with its country', async () => {
    create();
    (await awaitRequest(fixture, controller, ME)).flush(MORGAN);
    await settle(fixture);

    const phone = (fixture.nativeElement as HTMLElement).querySelector('app-phone-field');
    expect(phone?.querySelector('input')?.value).toBe('+1-503-555-0142');
    expect(phone?.querySelector('[data-country]')?.getAttribute('data-country')).toBe('US');
  });

  it('derives the initials from the full name', async () => {
    create();
    (await awaitRequest(fixture, controller, ME)).flush(MORGAN);
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('MR');
  });

  /**
   * WHY: boot already populated the store, so a refresh must not blank the
   * screen — only a first load with nothing to show renders the skeleton.
   */
  it('keeps showing a stored profile while refreshing it', async () => {
    TestBed.inject(SessionStore).setUser(MORGAN);
    create();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Morgan Reyes');
    expect(root.querySelector('[aria-busy="true"]')).toBeNull();

    (await awaitRequest(fixture, controller, ME)).flush(MORGAN);
    await settle(fixture);
  });

  it('renders an error state with a retry that refetches', async () => {
    create();
    (await awaitRequest(fixture, controller, ME)).flush(
      { message: 'Service unavailable' },
      { status: 503, statusText: 'Service Unavailable' },
    );
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    expect(textOf(fixture, '[role="alert"]')).toContain('We could not load your profile.');

    root.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
    (await awaitRequest(fixture, controller, ME)).flush(MORGAN);
    await settle(fixture);

    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.textContent).toContain('Morgan Reyes');
  });

  it('populates the shared session store, not just its own view', async () => {
    create();
    (await awaitRequest(fixture, controller, ME)).flush(MORGAN);
    await settle(fixture);

    expect(TestBed.inject(SessionStore).user()).toEqual(MORGAN);
  });

  /**
   * CONTRACT: With STRIPE_ENABLED off the profile keeps its pre-milestone
   * single-view shape — no Tabs frame and no SAVED CARDS section. Rendering the
   * tab greyed out instead offers card management the backend routes refuse.
   * See [[2026-09-19-stripe-payments-design]]
   */
  it('renders no payment-methods tab while STRIPE_ENABLED is off', async () => {
    withStripeEnabled(false);
    create();
    (await awaitRequest(fixture, controller, ME)).flush(MORGAN);
    await settle(fixture);

    expect(root().querySelector('app-payment-methods-tab')).toBeNull();
    expect(root().querySelector('[data-testid="tab-payment-methods"]')).toBeNull();
    // The Tabs FRAME itself, and the section behind it, named separately — the
    // tab button could go while its tablist and card section stayed.
    expect(root().querySelector('[data-testid="profile-tabs"]')).toBeNull();
    expect(root().querySelector('[data-testid="saved-cards-section"]')).toBeNull();
    expect(root().textContent).not.toContain('SAVED CARDS');
    // The single view still renders, so "absent" is the gate and not a dead screen.
    expect(root().textContent).toContain('Morgan Reyes');
    expect(root().textContent).toContain('DELIVERY ADDRESS');
  });

  it('mounts the payment-methods tab while STRIPE_ENABLED is on', async () => {
    withStripeEnabled(true);
    create();
    (await awaitRequest(fixture, controller, ME)).flush(MORGAN);
    await settle(fixture);

    expect(root().querySelector('app-payment-methods-tab')).not.toBeNull();
    expect(root().querySelector('[data-testid="tab-payment-methods"]')).not.toBeNull();
  });
});
