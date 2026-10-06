import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { ErrorHandler } from '@angular/core';
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
import { ApiError } from '../../core/http/api-client';
import { StripeLoader } from '../../core/payments/stripe-loader';
import { SessionStore } from '../../core/auth/session-store';
import { SAVED_BANNER_DISMISS_MS } from '../../shared/ui/saved-banner';
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
  let handleError: ReturnType<typeof vi.fn>;

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
    handleError = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: ErrorHandler, useValue: { handleError } },
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

  describe('failed save', () => {
    const UNAVAILABLE = { message: 'Service unavailable' };

    async function editCityAndFailSave(): Promise<void> {
      create();
      (await awaitRequest(fixture, controller, ME)).flush(MORGAN);
      await settle(fixture);

      fillField(fixture, 'City', 'Salem');
      root().querySelector<HTMLButtonElement>('app-button-primary button')?.click();
      await settle(fixture);
      (await awaitRequest(fixture, controller, ME)).flush(UNAVAILABLE, {
        status: 503,
        statusText: 'Service Unavailable',
      });
      await settle(fixture);
    }

    /**
     * CONTRACT: A failed save neither reseeds the form nor clears its error.
     * `saving` flipping back to false is not a new server user, so a reseed on
     * it discards the edits and hides the message in the same tick.
     */
    it('keeps the edits and shows the save-error banner', async () => {
      await editCityAndFailSave();

      expect(fieldValues()).toContain('Salem');
      expect(fieldValues()).not.toContain('Portland');
      expect(textOf(fixture, '[role="alert"]')).toContain('Couldn’t save your changes');
    });

    /** CONTRACT: Rendered AND reported — see [[browser-rum]]. */
    it('reports the failure to ErrorHandler', async () => {
      await editCityAndFailSave();

      expect(handleError).toHaveBeenCalledTimes(1);
      const [reported] = handleError.mock.calls[0] as [unknown];
      expect(reported).toBeInstanceOf(ApiError);
      expect((reported as ApiError).status).toBe(503);
    });

    it('re-sends the preserved edits on the next save', async () => {
      await editCityAndFailSave();

      root().querySelector<HTMLButtonElement>('app-button-primary button')?.click();
      await settle(fixture);
      const patch = await awaitRequest(fixture, controller, ME);
      expect(patch.request.body).toMatchObject({ address: { city: 'Salem' } });
      patch.flush({ ...MORGAN, address: { ...MORGAN.address, city: 'Salem' } });
      await settle(fixture);

      expect(root().querySelector('[role="alert"]')).toBeNull();
    });
  });

  describe('save-error banner', () => {
    const ERROR_BANNER = '[data-testid="profile-save-error-banner"]';
    const SAVED_BANNER = '[data-testid="profile-saved-banner"]';
    const SALEM = { ...MORGAN, address: { ...MORGAN.address, city: 'Salem' } };

    const errorBanner = () => root().querySelector<HTMLElement>(ERROR_BANNER);
    const savedBanner = () => root().querySelector<HTMLElement>(SAVED_BANNER);
    const retryButton = () =>
      root().querySelector<HTMLButtonElement>('[data-testid="profile-save-error-retry"]');
    const saveButton = () => root().querySelector<HTMLButtonElement>('app-button-primary button');

    const fail = (patch: TestRequest) =>
      patch.flush({ message: 'Service unavailable' }, { status: 503, statusText: 'Unavailable' });

    async function loaded(): Promise<void> {
      create();
      (await awaitRequest(fixture, controller, ME)).flush(MORGAN);
      await settle(fixture);
    }

    /** Clicks `button`, then answers the PATCH it sends with `respond`. */
    async function sendVia(
      button: HTMLButtonElement | null,
      respond: (patch: TestRequest) => void,
    ): Promise<TestRequest> {
      button?.click();
      await settle(fixture);
      const patch = await awaitRequest(fixture, controller, ME);
      respond(patch);
      await settle(fixture);
      return patch;
    }

    async function editCityAndFail(): Promise<void> {
      await loaded();
      fillField(fixture, 'City', 'Salem');
      await sendVia(saveButton(), fail);
    }

    function clickCancel(): void {
      Array.from(root().querySelectorAll('button'))
        .find((b) => b.textContent?.trim() === 'Cancel')
        ?.click();
    }

    it('is absent until a save fails', async () => {
      await loaded();
      expect(errorBanner()).toBeNull();

      fillField(fixture, 'City', 'Salem');
      await sendVia(saveButton(), fail);

      expect(errorBanner()).not.toBeNull();
      expect(errorBanner()?.getAttribute('role')).toBe('alert');
      expect(textOf(fixture, ERROR_BANNER)).toContain('Couldn’t save your changes');
      expect(textOf(fixture, ERROR_BANNER)).toContain(
        'Something went wrong on our side. Your edits are still here — try again in a moment.',
      );
    });

    /**
     * CONTRACT: One error rendering. The server detail goes to ErrorHandler,
     * not the page — a second alert beside the banner announces twice.
     */
    it('is the only alert on the page, with no server message rendered', async () => {
      await editCityAndFail();

      expect(root().querySelectorAll('[role="alert"]')).toHaveLength(1);
      expect(root().textContent).not.toContain('Service unavailable');
      expect(errorBanner()?.closest('[role="status"]')).toBeNull();
    });

    it('re-sends the edited values on Try again, then swaps to the saved banner', async () => {
      await editCityAndFail();

      const patch = await sendVia(retryButton(), (req) => req.flush(SALEM));

      expect(patch.request.method).toBe('PATCH');
      expect(patch.request.body).toMatchObject({ address: { city: 'Salem' } });
      expect(errorBanner()).toBeNull();
      expect(savedBanner()).not.toBeNull();
    });

    it('stays up and reports again when Try again fails too', async () => {
      await editCityAndFail();
      expect(handleError).toHaveBeenCalledTimes(1);

      await sendVia(retryButton(), fail);

      expect(errorBanner()).not.toBeNull();
      expect(savedBanner()).toBeNull();
      expect(fieldValues()).toContain('Salem');
      expect(handleError).toHaveBeenCalledTimes(2);
      expect(handleError.mock.calls[1]?.[0]).toBeInstanceOf(ApiError);
    });

    it('disables Try again and Save while the request is in flight', async () => {
      await editCityAndFail();
      expect(retryButton()?.disabled).toBe(false);

      retryButton()?.click();
      await settle(fixture);
      const patch = await awaitRequest(fixture, controller, ME);

      expect(errorBanner()).not.toBeNull();
      expect(retryButton()?.disabled).toBe(true);
      expect(retryButton()?.getAttribute('aria-busy')).toBe('true');
      expect(saveButton()?.disabled).toBe(true);

      patch.flush(SALEM);
      await settle(fixture);
    });

    it('hides when its dismiss button is pressed, keeping the edits', async () => {
      await editCityAndFail();

      root().querySelector<HTMLButtonElement>('[data-testid="profile-save-error-dismiss"]')?.click();
      await settle(fixture);

      expect(errorBanner()).toBeNull();
      expect(fieldValues()).toContain('Salem');
    });

    it('hides on Cancel', async () => {
      await editCityAndFail();

      clickCancel();
      await settle(fixture);

      expect(errorBanner()).toBeNull();
      expect(fieldValues()).toContain('Portland');
    });

    it('stays up while the user keeps editing', async () => {
      await editCityAndFail();

      fillField(fixture, 'ZIP Code', '97301');
      fillField(fixture, 'Full name', 'Morgan R. Reyes');
      await settle(fixture);

      expect(errorBanner()).not.toBeNull();
    });

    it('replaces a visible saved banner when the next save fails', async () => {
      await loaded();
      await sendVia(saveButton(), (patch) => patch.flush(MORGAN));
      expect(savedBanner()).not.toBeNull();

      await sendVia(saveButton(), fail);

      expect(savedBanner()).toBeNull();
      expect(errorBanner()).not.toBeNull();
    });

    it('is replaced by the saved banner when a plain Save succeeds', async () => {
      await editCityAndFail();

      await sendVia(saveButton(), (patch) => patch.flush(SALEM));

      expect(errorBanner()).toBeNull();
      expect(savedBanner()).not.toBeNull();
    });

    it('renders above the Save/Cancel row', async () => {
      await editCityAndFail();

      const save = root().querySelector('app-button-primary');
      expect(errorBanner()).toBeTruthy();
      expect(save).toBeTruthy();
      expect(errorBanner()!.compareDocumentPosition(save!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    /** WORKAROUND(test): jsdom has no `Element.scrollTo` — see the saved-banner block. */
    describe('scroll to the end of the page', () => {
      let scrolled: ReturnType<typeof vi.fn>;

      beforeEach(() => {
        scrolled = vi.fn();
        Object.defineProperty(Element.prototype, 'scrollTo', {
          value: scrolled,
          configurable: true,
          writable: true,
        });
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }) as MediaQueryList);
      });

      afterEach(() => {
        delete (Element.prototype as Partial<Element>).scrollTo;
        vi.unstubAllGlobals();
      });

      it('scrolls once when the banner appears, not again on a repeat failure', async () => {
        await editCityAndFail();
        expect(scrolled).toHaveBeenCalledTimes(1);
        expect(scrolled).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));

        await sendVia(retryButton(), fail);

        expect(scrolled).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('reseeding from the session user', () => {
    async function loaded(): Promise<void> {
      create();
      (await awaitRequest(fixture, controller, ME)).flush(MORGAN);
      await settle(fixture);
    }

    it('reseeds when a new server user arrives while not saving', async () => {
      await loaded();

      TestBed.inject(SessionStore).setUser({
        ...MORGAN,
        address: { ...MORGAN.address, city: 'Eugene' },
      });
      await settle(fixture);

      expect(fieldValues()).toContain('Eugene');
    });

    it('reseeds from the user a successful save returns', async () => {
      await loaded();

      fillField(fixture, 'City', 'salem');
      root().querySelector<HTMLButtonElement>('app-button-primary button')?.click();
      await settle(fixture);
      (await awaitRequest(fixture, controller, ME)).flush({
        ...MORGAN,
        address: { ...MORGAN.address, city: 'Salem' },
      });
      await settle(fixture);

      expect(fieldValues()).toContain('Salem');
      expect(fieldValues()).not.toContain('salem');
    });
  });

  describe('saved banner', () => {
    const BANNER = '[data-testid="profile-saved-banner"]';

    function banner(): HTMLElement | null {
      return root().querySelector<HTMLElement>(BANNER);
    }

    async function loaded(): Promise<void> {
      create();
      (await awaitRequest(fixture, controller, ME)).flush(MORGAN);
      await settle(fixture);
    }

    async function saveWith(respond: (patch: TestRequest) => void): Promise<void> {
      root().querySelector<HTMLButtonElement>('app-button-primary button')?.click();
      await settle(fixture);
      respond(await awaitRequest(fixture, controller, ME));
      await settle(fixture);
    }

    const succeed = (patch: TestRequest) => patch.flush(MORGAN);

    it('is absent until a save succeeds', async () => {
      await loaded();
      expect(banner()).toBeNull();

      await saveWith(succeed);

      expect(banner()).not.toBeNull();
      expect(textOf(fixture, BANNER)).toContain('Changes saved');
      expect(textOf(fixture, BANNER)).toContain('Your personal details are up to date.');
      // WHY: the live region must already be mounted for the announcement to fire.
      expect(banner()?.closest('[role="status"]')).not.toBeNull();
    });

    it('stays absent after a failed save', async () => {
      await loaded();

      await saveWith((patch) =>
        patch.flush({ message: 'Service unavailable' }, { status: 503, statusText: 'Unavailable' }),
      );

      expect(banner()).toBeNull();
    });

    it('hides once a field is edited after the save', async () => {
      await loaded();
      await saveWith(succeed);
      expect(banner()).not.toBeNull();

      fillField(fixture, 'City', 'Salem');
      await settle(fixture);

      expect(banner()).toBeNull();
    });

    it('hides as soon as another save starts', async () => {
      await loaded();
      await saveWith(succeed);
      expect(banner()).not.toBeNull();

      root().querySelector<HTMLButtonElement>('app-button-primary button')?.click();
      await settle(fixture);
      const patch = await awaitRequest(fixture, controller, ME);

      expect(banner()).toBeNull();
      patch.flush(MORGAN);
      await settle(fixture);
    });

    it('hides on Cancel', async () => {
      await loaded();
      await saveWith(succeed);

      Array.from(root().querySelectorAll('button'))
        .find((b) => b.textContent?.trim() === 'Cancel')
        ?.click();
      await settle(fixture);

      expect(banner()).toBeNull();
    });

    it('hides when its dismiss button is pressed', async () => {
      await loaded();
      await saveWith(succeed);

      root().querySelector<HTMLButtonElement>('[data-testid="profile-saved-banner-dismiss"]')?.click();
      await settle(fixture);

      expect(banner()).toBeNull();
    });

    it('renders its live region above the Save/Cancel row', async () => {
      await loaded();
      await saveWith(succeed);

      const region = banner()?.closest('[role="status"]');
      const save = root().querySelector('app-button-primary');
      expect(region).toBeTruthy();
      expect(save).toBeTruthy();
      expect(region!.compareDocumentPosition(save!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    /**
     * WORKAROUND(test): jsdom implements neither `Element.scrollTo` nor
     * `matchMedia`, so both are stubbed here. Unstubbed, the component's guard
     * skips the scroll and every assertion below sees zero calls.
     */
    describe('scroll to the end of the page', () => {
      let scrolled: ReturnType<typeof vi.fn>;

      function stubMotion(reduced: boolean): void {
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced, media: query }) as MediaQueryList);
      }

      beforeEach(() => {
        scrolled = vi.fn();
        Object.defineProperty(Element.prototype, 'scrollTo', {
          value: scrolled,
          configurable: true,
          writable: true,
        });
        stubMotion(false);
      });

      afterEach(() => {
        delete (Element.prototype as Partial<Element>).scrollTo;
        vi.unstubAllGlobals();
      });

      it('scrolls the enclosing .app-scroll column to its end, smoothly', async () => {
        await loaded();
        const column = document.createElement('div');
        column.className = 'app-scroll';
        Object.defineProperty(column, 'scrollHeight', { value: 1800 });
        const host = fixture.nativeElement as HTMLElement;
        host.parentElement!.insertBefore(column, host);
        column.appendChild(host);
        expect(scrolled).not.toHaveBeenCalled();

        await saveWith(succeed);

        expect(scrolled).toHaveBeenCalledTimes(1);
        expect(scrolled).toHaveBeenCalledWith({ top: 1800, behavior: 'smooth' });
        expect(scrolled.mock.contexts[0]).toBe(column);
      });

      it('falls back to the document scroller outside AppLayout', async () => {
        await loaded();

        await saveWith(succeed);

        expect(scrolled).toHaveBeenCalledTimes(1);
        expect(scrolled.mock.contexts[0]).toBe(document.documentElement);
      });

      it('scrolls instantly under prefers-reduced-motion', async () => {
        stubMotion(true);
        await loaded();

        await saveWith(succeed);

        expect(scrolled).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
      });

      it('does not scroll when the banner hides', async () => {
        await loaded();
        await saveWith(succeed);
        scrolled.mockClear();

        root().querySelector<HTMLButtonElement>('[data-testid="profile-saved-banner-dismiss"]')?.click();
        await settle(fixture);
        fillField(fixture, 'City', 'Salem');
        await settle(fixture);

        expect(banner()).toBeNull();
        expect(scrolled).not.toHaveBeenCalled();
      });
    });

    /**
     * CONTRACT: Fake timers go in only AFTER the profile loads, and the save is
     * driven by `fakePump`, never `settle` — `settle` waits on a real
     * `setTimeout(0)` that a faked clock never fires, and the test hangs.
     */
    describe('auto-dismiss', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      async function fakePump(turns = 10): Promise<void> {
        for (let turn = 0; turn < turns; turn += 1) {
          await vi.advanceTimersByTimeAsync(0);
          fixture.detectChanges();
        }
      }

      async function fakeSave(): Promise<void> {
        root().querySelector<HTMLButtonElement>('app-button-primary button')?.click();
        for (let turn = 0; turn < 50; turn += 1) {
          const [patch] = controller.match((req) => req.url.endsWith(ME) && req.method === 'PATCH');
          if (patch) {
            patch.flush(MORGAN);
            await fakePump();
            return;
          }
          await fakePump(1);
        }
        throw new Error('PATCH /v1/users/me never sent');
      }

      async function loadedWithFakeTimers(): Promise<void> {
        await loaded();
        vi.useFakeTimers();
      }

      async function elapse(ms: number): Promise<void> {
        await vi.advanceTimersByTimeAsync(ms);
        await fakePump(2);
      }

      it('hides after SAVED_BANNER_DISMISS_MS and not before', async () => {
        await loadedWithFakeTimers();
        await fakeSave();

        await elapse(SAVED_BANNER_DISMISS_MS - 1);
        expect(banner()).not.toBeNull();

        await elapse(1);
        expect(banner()).toBeNull();
      });

      it('hides immediately on the X, leaving no timer to hide a later banner early', async () => {
        await loadedWithFakeTimers();
        await fakeSave();

        await elapse(4000);
        root().querySelector<HTMLButtonElement>('[data-testid="profile-saved-banner-dismiss"]')?.click();
        await fakePump(2);
        expect(banner()).toBeNull();

        await fakeSave();
        await elapse(SAVED_BANNER_DISMISS_MS - 1);
        expect(banner()).not.toBeNull();
      });

      it('leaves no timer behind after an edit hides it', async () => {
        await loadedWithFakeTimers();
        await fakeSave();

        await elapse(4000);
        fillField(fixture, 'City', 'Salem');
        await fakePump(2);
        expect(banner()).toBeNull();

        fillField(fixture, 'City', 'Portland');
        await fakeSave();
        await elapse(SAVED_BANNER_DISMISS_MS - 1);
        expect(banner()).not.toBeNull();
      });

      it('restarts the full countdown on a new successful save', async () => {
        await loadedWithFakeTimers();
        await fakeSave();

        await elapse(4000);
        await fakeSave();
        await elapse(SAVED_BANNER_DISMISS_MS - 1);
        expect(banner()).not.toBeNull();
        await elapse(1);
        expect(banner()).toBeNull();
      });
    });
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
    expect(handleError).toHaveBeenCalledTimes(1);
    expect(handleError.mock.calls[0]?.[0]).toBeInstanceOf(ApiError);

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
