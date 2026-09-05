import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { ProfilePage } from './profile';
import { SessionStore } from '../../core/auth/session-store';
import { awaitRequest, settle, textOf, USER } from '../auth/testing';

import { SCREEN_TEST_PROVIDERS } from '../../shared/testing/fixtures';

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

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        ...SCREEN_TEST_PROVIDERS,
      ],
    });
    await TestBed.compileComponents();
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify({ ignoreCancelled: true });
    TestBed.resetTestingModule();
  });

  /** Every `app-field` input's value — where Field puts its content. */
  function fieldValues(): string[] {
    const root = fixture.nativeElement as HTMLElement;
    return Array.from(root.querySelectorAll('app-field input')).map((i) => (i as HTMLInputElement).value);
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
});
