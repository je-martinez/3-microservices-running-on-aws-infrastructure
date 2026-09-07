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

  function spinner(): HTMLElement | null {
    return root().querySelector('[data-testid="street-lookup-spinner"]');
  }

  function statusRow(): HTMLElement | null {
    return root().querySelector('[data-testid="street-lookup-status"]');
  }

  function statusText(): string | undefined {
    return statusRow()?.textContent?.trim();
  }

  function busy(): string | null {
    return input().getAttribute('aria-busy');
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

    /** No pipeline exists, so nothing could ever clear an indicator shown here. */
    it('renders no loading indicator at all, not even its reserved slot', () => {
      type('Avenida Winston');

      expect(spinner()).toBeNull();
      expect(root().querySelector('[data-testid="street-lookup-slot"]')).toBeNull();
      expect(statusRow()).toBeNull();
      expect(busy()).toBeNull();

      settle();
      expect(spinner()).toBeNull();
      expect(geocodeRequests()).toHaveLength(0);
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

    /**
     * CONTRACT: "Searching…" and "No matches" must not look alike. They were
     * the same empty dropdown before, which is precisely why the field read as
     * dead while a lookup was in flight.
     */
    it('tells a finished empty search apart from one still running', () => {
      type('Avenida');
      fixture.detectChanges();
      expect(statusText()).toBe('Searching…');

      settle();
      geocodeRequests()[0].flush({ features: [] });
      fixture.detectChanges();

      expect(statusText()).toBe('No matches');
      expect(options()).toHaveLength(0);
      expect(busy()).toBe('false');
    });

    it('shows no status row before the buyer has typed anything', () => {
      expect(statusRow()).toBeNull();
      expect(root().querySelector('[data-testid="street-suggestions"]')).toBeNull();
      expect(busy()).toBe('false');
    });

    describe('loading feedback', () => {
      /**
       * CONTRACT: THE point of this indicator. The 300ms debounce is part of
       * the interval that reads as a dead control, so pending must be visible
       * before any request exists — asserting it only after `settle()` would
       * pass against the exact behaviour the buyer complained about.
       */
      it('shows the spinner immediately on typing, before the debounce elapses', () => {
        type('Avenida');
        fixture.detectChanges();

        expect(spinner()).not.toBeNull();
        expect(busy()).toBe('true');
        expect(statusText()).toBe('Searching…');
        expect(geocodeRequests()).toHaveLength(0);

        settle();
        geocodeRequests()[0].flush({ features: [] });
      });

      it('clears the spinner once results arrive', () => {
        suggest('Avenida', [CHURCHILL]);

        expect(spinner()).toBeNull();
        expect(busy()).toBe('false');
        expect(statusRow()).toBeNull();
        expect(options()).toHaveLength(1);
      });

      /** Case 1: `of([])` short-circuits, so a spinner set here never clears. */
      it('never spins below the minimum query length, and issues no request', () => {
        type('Av');
        fixture.detectChanges();
        expect(spinner()).toBeNull();
        expect(busy()).toBe('false');

        settle();
        expect(spinner()).toBeNull();
        expect(geocodeRequests()).toHaveLength(0);
      });

      it('stops spinning when the query is cut back below the minimum', () => {
        type('Avenida');
        fixture.detectChanges();
        expect(spinner()).not.toBeNull();

        type('Av');
        fixture.detectChanges();

        expect(spinner()).toBeNull();
        expect(busy()).toBe('false');
        settle();
        expect(geocodeRequests()).toHaveLength(0);
      });

      /**
       * CONTRACT: Case 2 — a superseded request emits NOTHING. The spinner must
       * stay up rather than flicker off and on, because a newer lookup for what
       * the buyer is typing right now is still running.
       */
      it('keeps spinning across a superseded request and clears on the newer one', () => {
        type('Avenida');
        settle();
        const first = geocodeRequests()[0];
        expect(spinner()).not.toBeNull();

        type('Calle El Conde');
        fixture.detectChanges();
        expect(spinner()).not.toBeNull();

        // The supersession lands only once the NEW query clears the debounce
        // and reaches switchMap; the spinner must span that gap unbroken.
        settle();
        expect(first.cancelled).toBe(true);
        expect(spinner()).not.toBeNull();

        geocodeRequests()[0].flush({ features: [CONDE] });
        fixture.detectChanges();

        expect(spinner()).toBeNull();
        expect(busy()).toBe('false');
        expect(options()).toHaveLength(1);
      });

      /**
       * CONTRACT: Case 3 — distinctUntilChanged swallows a repeat, so nothing
       * downstream ever emits for it. A pending flag started on that keystroke
       * would spin forever over a list that is already correct.
       */
      it('does not strand the spinner when a repeat query is swallowed', () => {
        suggest('Avenida', [CHURCHILL]);
        expect(spinner()).toBeNull();

        // Trims back to the same "Avenida", so the pipeline emits nothing.
        type('Avenida ');
        fixture.detectChanges();
        settle();

        expect(geocodeRequests()).toHaveLength(0);
        expect(spinner()).toBeNull();
        expect(busy()).toBe('false');
        expect(options()).toHaveLength(1);
      });

      it.each([
        ['a 503 from the disabled proxy', 503],
        ['a 500 from the upstream', 500],
      ])('clears the spinner on %s', (_name, status) => {
        type('Avenida');
        settle();
        expect(spinner()).not.toBeNull();

        geocodeRequests()[0].flush(
          { error: 'geocoding_disabled' },
          { status, statusText: 'Error' },
        );
        fixture.detectChanges();

        expect(spinner()).toBeNull();
        expect(busy()).toBe('false');
        expect(statusText()).toBe('No matches');
        expect(root().querySelector('[role="alert"]')).toBeNull();
      });

      it('clears the spinner on a network error', () => {
        type('Avenida');
        settle();
        expect(spinner()).not.toBeNull();

        geocodeRequests()[0].error(new ProgressEvent('error'));
        fixture.detectChanges();

        expect(spinner()).toBeNull();
        expect(busy()).toBe('false');
        expect(input().disabled).toBe(false);
      });

      it('clears the spinner on Escape while a lookup is in flight', () => {
        type('Avenida');
        settle();
        expect(spinner()).not.toBeNull();

        input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        fixture.detectChanges();

        expect(spinner()).toBeNull();
        expect(busy()).toBe('false');
        expect(statusRow()).toBeNull();

        geocodeRequests()[0].flush({ features: [CHURCHILL] });
      });

      it('leaves no spinner behind after a suggestion is chosen', () => {
        suggest('Avenida', [CHURCHILL]);
        options()[0].dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
        );
        fixture.detectChanges();

        expect(spinner()).toBeNull();
        expect(busy()).toBe('false');
        expect(statusRow()).toBeNull();
      });

      /**
       * CONTRACT: The open list carries zero options while searching, so an
       * ArrowDown would compute `% 0`. NaN in activeIndex kills highlighting
       * for good, and nothing about it is visible at build time.
       */
      it('survives arrow keys pressed while the list shows only "Searching…"', () => {
        type('Avenida');
        fixture.detectChanges();

        input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
        fixture.detectChanges();

        settle();
        geocodeRequests()[0].flush({ features: [CHURCHILL, CONDE] });
        fixture.detectChanges();

        input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        fixture.detectChanges();

        expect(options()[0].getAttribute('aria-selected')).toBe('true');
        expect(input().getAttribute('aria-activedescendant')).toBe(options()[0].id);
      });
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
