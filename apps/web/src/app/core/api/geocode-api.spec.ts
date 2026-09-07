import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { GeocodeApi, type StreetSuggestion } from './geocode-api';

describe('GeocodeApi', () => {
  let geocodeApi: GeocodeApi;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    geocodeApi = TestBed.inject(GeocodeApi);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify();
    TestBed.resetTestingModule();
  });

  function expectRequest() {
    return controller.expectOne((request) => request.url === '/geocode/');
  }

  /**
   * CONTRACT: The path must stay OUTSIDE the "/v1" gateway prefix. Under it,
   * ApiClient's contract and authInterceptor's `isPublic` both change meaning —
   * the call would 404 at the gateway and carry our Cognito token there.
   */
  it('calls the same-origin proxy without the gateway prefix', () => {
    geocodeApi.suggest('Av Winston').subscribe();

    const request = expectRequest();
    expect(request.request.method).toBe('GET');
    expect(request.request.url).not.toContain('/v1');
    request.flush({ features: [] });
  });

  it('sends the query, the country filter and a limit', () => {
    geocodeApi.suggest('Av Winston').subscribe();

    const request = expectRequest();
    expect(request.request.params.get('text')).toBe('Av Winston');
    expect(request.request.params.get('filter')).toBe('countrycode:do');
    expect(request.request.params.get('limit')).toBe('5');
    request.flush({ features: [] });
  });

  /**
   * CONTRACT: Never send a bearer token to a third party. authInterceptor skips
   * this path because it is not under "/v1"; this asserts the outcome rather
   * than the mechanism, so a change to either still fails the test.
   */
  it('attaches no Authorization header', () => {
    geocodeApi.suggest('Av Winston').subscribe();

    const request = expectRequest();
    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush({ features: [] });
  });

  it('maps a feature into an Address, uppercasing the lowercase country_code', () => {
    let received: StreetSuggestion[] | undefined;
    geocodeApi.suggest('Av Winston').subscribe((s) => (received = s));

    expectRequest().flush({
      features: [
        {
          properties: {
            place_id: '51a2b3',
            formatted: 'Avenida Winston Churchill, Santo Domingo, Dominican Republic',
            address_line1: 'Avenida Winston Churchill',
            street: 'Avenida Winston Churchill',
            city: 'Santo Domingo',
            state: 'Distrito Nacional',
            postcode: '10148',
            country: 'Dominican Republic',
            country_code: 'do',
          },
        },
      ],
    });

    expect(received).toHaveLength(1);
    expect(received?.[0].id).toBe('51a2b3');
    expect(received?.[0].label).toBe(
      'Avenida Winston Churchill, Santo Domingo, Dominican Republic',
    );
    expect(received?.[0].address).toEqual({
      line1: 'Avenida Winston Churchill',
      line2: null,
      city: 'Santo Domingo',
      state: 'Distrito Nacional',
      postalCode: '10148',
      country: 'DO',
    });
  });

  /**
   * CONTRACT: A Dominican result usually carries no postcode and no
   * housenumber. Every absent field becomes an empty string, never `undefined`
   * — `Address` declares them as strings and a consumer would render "undefined".
   */
  it('fills absent properties with empty strings rather than undefined', () => {
    let received: StreetSuggestion[] | undefined;
    geocodeApi.suggest('Calle El Conde').subscribe((s) => (received = s));

    expectRequest().flush({
      features: [
        { properties: { street: 'Calle El Conde', city: 'Santo Domingo', country_code: 'do' } },
      ],
    });

    expect(received?.[0].address).toEqual({
      line1: 'Calle El Conde',
      line2: null,
      city: 'Santo Domingo',
      state: '',
      postalCode: '',
      country: 'DO',
    });
    expect(received?.[0].id).toBe('suggestion-0');
  });

  /** A city-only result cannot fill `line1`, so offering it would clear the field. */
  it('drops a feature with no street', () => {
    let received: StreetSuggestion[] | undefined;
    geocodeApi.suggest('Santiago').subscribe((s) => (received = s));

    expectRequest().flush({
      features: [{ properties: { city: 'Santiago', country_code: 'do' } }],
    });

    expect(received).toEqual([]);
  });

  /**
   * CONTRACT: THE requirement this service exists to honour. A checkout form
   * must never be blocked by a geocoding outage, so every failure resolves to
   * an empty list — the observable NEVER errors.
   */
  it.each([
    ['a 503 from the disabled proxy', 503, { error: 'geocoding_disabled' }],
    ['a 500 from the upstream', 500, { error: 'boom' }],
  ])('degrades to no suggestions on %s', (_name, status, body) => {
    let received: StreetSuggestion[] | undefined;
    let errored = false;
    geocodeApi.suggest('Av Winston').subscribe({
      next: (s) => (received = s),
      error: () => (errored = true),
    });

    expectRequest().flush(body, { status, statusText: 'Error' });

    expect(errored).toBe(false);
    expect(received).toEqual([]);
  });

  it('degrades to no suggestions on a network error', () => {
    let received: StreetSuggestion[] | undefined;
    let errored = false;
    geocodeApi.suggest('Av Winston').subscribe({
      next: (s) => (received = s),
      error: () => (errored = true),
    });

    expectRequest().error(new ProgressEvent('error'));

    expect(errored).toBe(false);
    expect(received).toEqual([]);
  });

  /** A body with no `features` array must not throw where a 200 was expected. */
  it('degrades to no suggestions on a body with no features array', () => {
    let received: StreetSuggestion[] | undefined;
    geocodeApi.suggest('Av Winston').subscribe((s) => (received = s));

    expectRequest().flush({});

    expect(received).toEqual([]);
  });
});
