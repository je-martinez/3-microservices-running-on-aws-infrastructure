import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LucideMapPin, provideLucideIcons } from '@lucide/angular';

import { StreetAutocomplete } from './street-autocomplete';
import { APP_CONFIG } from '../../core/config/app-config';
import type { Address } from '../../core/api/types';

/** Longer than the component's 300ms debounce, so one tick always flushes it. */
const PAST_DEBOUNCE = 400;

const CHURCHILL = {
  properties: {
    place_id: 'churchill',
    formatted: 'Avenida Winston Churchill, Santo Domingo, Dominican Republic',
    address_line1: 'Avenida Winston Churchill',
    street: 'Avenida Winston Churchill',
    city: 'Santo Domingo',
    state: 'Distrito Nacional',
    postcode: '10148',
    country: 'Dominican Republic',
    country_code: 'do',
  },
};

const CONDE = {
  properties: {
    place_id: 'conde',
    formatted: 'Calle El Conde, Santo Domingo',
    address_line1: 'Calle El Conde',
    city: 'Santo Domingo',
    country_code: 'do',
  },
};

describe('StreetAutocomplete', () => {
  let fixture: ComponentFixture<StreetAutocomplete>;
  let controller: HttpTestingController;

  const GEOCODE_ENABLED = APP_CONFIG.geocodeEnabled;

  /**
   * CONTRACT: Restore this in `afterEach`. APP_CONFIG is a module-level const
   * shared by every spec in the run, so a redefinition left in place leaks the
   * flag into unrelated files — which then pass or fail by test ORDER.
   */
  function withGeocodeEnabled(enabled: boolean): void {
    Object.defineProperty(APP_CONFIG, 'geocodeEnabled', {
      value: enabled,
      configurable: true,
      writable: false,
    });
  }

  /**
   * CONTRACT: Create the component AFTER setting the flag. The constructor
   * reads it once to decide whether to build the request pipeline at all, so a
   * fixture created first ignores whatever the test sets afterwards.
   */
  function build(): void {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideLucideIcons(LucideMapPin),
      ],
    });
    controller = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(StreetAutocomplete);
    fixture.componentRef.setInput('label', 'Street address');
    fixture.detectChanges();
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    withGeocodeEnabled(GEOCODE_ENABLED);
    controller.verify({ ignoreCancelled: true });
    TestBed.resetTestingModule();
  });

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function input(): HTMLInputElement {
    const element = root().querySelector('input');
    if (!element) throw new Error('no input rendered');
    return element;
  }

  function type(text: string): void {
    const element = input();
    element.value = text;
    element.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  /** Advances past the debounce and re-renders whatever the response produced. */
  function settle(): void {
    vi.advanceTimersByTime(PAST_DEBOUNCE);
    fixture.detectChanges();
  }

  function geocodeRequests() {
    return controller.match((request) => request.url === '/geocode/');
  }

  function options(): HTMLElement[] {
    return Array.from(root().querySelectorAll('[role="option"]'));
  }

  /** Types a query, flushes the debounce and answers with the given features. */
  function suggest(text: string, features: unknown[]): void {
    type(text);
    settle();
    geocodeRequests()[0].flush({ features });
    fixture.detectChanges();
  }

  describe('with the flag off', () => {
    beforeEach(() => {
      withGeocodeEnabled(false);
      build();
    });

    /**
     * CONTRACT: THE reason the flag exists. An unconfigured deployment answers
     * 503 on every keystroke, so the field must not ask at all — and the buyer
     * still gets a working address input.
     */
    it('makes zero requests however much is typed', () => {
      type('Avenida Winston Churchill');
      settle();
      type('Calle El Conde 42');
      settle();

      expect(geocodeRequests()).toHaveLength(0);
    });

    it('renders a plain text input with no combobox semantics', () => {
      expect(input().getAttribute('role')).toBeNull();
      expect(input().getAttribute('aria-expanded')).toBeNull();
      expect(root().querySelector('[data-testid="street-suggestions"]')).toBeNull();
    });

    it('still propagates what the buyer types', () => {
      const emitted: string[] = [];
      fixture.componentInstance.valueChange.subscribe((v) => emitted.push(v));

      type('Calle El Conde 42');

      expect(emitted).toEqual(['Calle El Conde 42']);
    });
  });

  describe('with the flag on', () => {
    beforeEach(() => {
      withGeocodeEnabled(true);
      build();
    });

    /**
     * CONTRACT: One request per pause, not per keystroke. Every call costs a
     * credit off a 3,000/day free tier, so a per-keystroke field exhausts the
     * quota inside one checkout.
     */
    it('sends exactly one request for a burst of keystrokes', () => {
      type('Av');
      vi.advanceTimersByTime(50);
      type('Ave');
      vi.advanceTimersByTime(50);
      type('Aveni');
      vi.advanceTimersByTime(50);
      type('Avenida');
      settle();

      const requests = geocodeRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0].request.params.get('text')).toBe('Avenida');
      requests[0].flush({ features: [] });
    });

    it('sends no request below the minimum query length', () => {
      type('Av');
      settle();

      expect(geocodeRequests()).toHaveLength(0);
    });

    it('sends no second request when the trimmed query is unchanged', () => {
      type('Avenida');
      settle();
      geocodeRequests()[0].flush({ features: [] });

      type('Avenida ');
      settle();

      expect(geocodeRequests()).toHaveLength(0);
    });

    it('clears the suggestions when the query drops below the minimum', () => {
      suggest('Avenida', [CHURCHILL]);
      expect(options()).toHaveLength(1);

      type('Av');
      settle();

      expect(options()).toHaveLength(0);
    });

    it('renders one option per suggestion, labelled by the formatted address', () => {
      suggest('Avenida', [CHURCHILL, CONDE]);

      expect(options().map((o) => o.textContent?.trim())).toEqual([
        'Avenida Winston Churchill, Santo Domingo, Dominican Republic',
        'Calle El Conde, Santo Domingo',
      ]);
      expect(input().getAttribute('aria-expanded')).toBe('true');
    });

    /**
     * CONTRACT: Selecting fills ALL five Address fields, with `country`
     * uppercased. `country_code` is lowercase on the wire while the profile
     * stores "DO" — passing it through writes a profile nothing rejects and
     * everything downstream disagrees with.
     */
    it('emits the whole resolved address when a suggestion is chosen', () => {
      const addresses: Address[] = [];
      const values: string[] = [];
      fixture.componentInstance.addressSelected.subscribe((a) => addresses.push(a));
      fixture.componentInstance.valueChange.subscribe((v) => values.push(v));

      suggest('Avenida', [CHURCHILL]);
      options()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      fixture.detectChanges();

      expect(addresses).toEqual([
        {
          line1: 'Avenida Winston Churchill',
          line2: null,
          city: 'Santo Domingo',
          state: 'Distrito Nacional',
          postalCode: '10148',
          country: 'DO',
        },
      ]);
      expect(values).toEqual(['Avenida', 'Avenida Winston Churchill']);
      expect(options()).toHaveLength(0);
    });

    it('moves through the list with the arrow keys and selects with Enter', () => {
      const addresses: Address[] = [];
      fixture.componentInstance.addressSelected.subscribe((a) => addresses.push(a));

      suggest('Avenida', [CHURCHILL, CONDE]);

      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      fixture.detectChanges();
      expect(options()[0].getAttribute('aria-selected')).toBe('true');
      expect(input().getAttribute('aria-activedescendant')).toBe(options()[0].id);

      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      fixture.detectChanges();
      expect(options()[1].getAttribute('aria-selected')).toBe('true');

      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
      fixture.detectChanges();
      expect(options()[0].getAttribute('aria-selected')).toBe('true');

      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      fixture.detectChanges();

      expect(addresses).toHaveLength(1);
      expect(addresses[0].line1).toBe('Avenida Winston Churchill');
    });

    it('wraps the highlight around both ends of the list', () => {
      suggest('Avenida', [CHURCHILL, CONDE]);

      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
      fixture.detectChanges();
      expect(options()[1].getAttribute('aria-selected')).toBe('true');

      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      fixture.detectChanges();
      expect(options()[0].getAttribute('aria-selected')).toBe('true');
    });

    /** Enter with nothing highlighted must not pick an arbitrary suggestion. */
    it('emits nothing on Enter while no option is highlighted', () => {
      const addresses: Address[] = [];
      fixture.componentInstance.addressSelected.subscribe((a) => addresses.push(a));

      suggest('Avenida', [CHURCHILL]);
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      fixture.detectChanges();

      expect(addresses).toEqual([]);
      expect(options()).toHaveLength(1);
    });

    it('dismisses the list on Escape and reopens it on the next keystroke', () => {
      suggest('Avenida', [CHURCHILL]);

      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      fixture.detectChanges();
      expect(options()).toHaveLength(0);
      expect(input().getAttribute('aria-expanded')).toBe('false');

      suggest('Avenida Winston', [CHURCHILL]);
      expect(options()).toHaveLength(1);
    });

    /**
     * CONTRACT: A superseded response must NEVER overwrite a newer one. Without
     * switchMap the slow first request lands last and replaces the suggestions
     * for what the buyer is actually typing now.
     */
    it('ignores a superseded in-flight response', () => {
      type('Avenida');
      settle();
      const first = geocodeRequests()[0];

      type('Calle El Conde');
      settle();
      const second = geocodeRequests()[0];

      second.flush({ features: [CONDE] });
      fixture.detectChanges();

      expect(first.cancelled).toBe(true);
      expect(options().map((o) => o.textContent?.trim())).toEqual([
        'Calle El Conde, Santo Domingo',
      ]);
    });

    /**
     * CONTRACT: THE most important behaviour here. A geocoding outage must
     * leave a usable input — no thrown error, no banner, no disabled control.
     */
    it.each([
      ['a 503 from the disabled proxy', 503],
      ['a 500 from the upstream', 500],
    ])('stays usable and silent on %s', (_name, status) => {
      type('Avenida');
      settle();
      geocodeRequests()[0].flush({ error: 'geocoding_disabled' }, { status, statusText: 'Error' });
      fixture.detectChanges();

      expect(options()).toHaveLength(0);
      expect(root().querySelector('[role="alert"]')).toBeNull();
      expect(input().disabled).toBe(false);

      // And the field keeps working afterwards.
      suggest('Calle El Conde', [CONDE]);
      expect(options()).toHaveLength(1);
    });

    it('stays usable and silent on a network error', () => {
      type('Avenida');
      settle();
      geocodeRequests()[0].error(new ProgressEvent('error'));
      fixture.detectChanges();

      expect(options()).toHaveLength(0);
      expect(root().querySelector('[role="alert"]')).toBeNull();
      expect(input().disabled).toBe(false);
    });

    it('renders no list for an empty result set', () => {
      suggest('Avenida', []);

      expect(root().querySelector('[data-testid="street-suggestions"]')).toBeNull();
      expect(input().getAttribute('aria-expanded')).toBe('false');
    });

    /** See geocode-api.spec.ts for the mapping; asserted here as a leak check. */
    it('attaches no Authorization header to the geocode request', () => {
      type('Avenida');
      settle();

      const request = geocodeRequests()[0];
      expect(request.request.headers.has('Authorization')).toBe(false);
      request.flush({ features: [] });
    });
  });
});
