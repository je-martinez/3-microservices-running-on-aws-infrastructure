import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';

import type { Address } from './types';

/**
 * One `features[].properties` object from Geoapify's autocomplete response.
 *
 * CONTRACT: Every field is OPTIONAL — Geoapify omits fields by location type,
 * and Dominican results routinely carry no `postcode` and no `housenumber`.
 * Typing them as required lets the compiler bless a read that is undefined on
 * the first Santo Domingo suggestion.
 * See [[2026-09-06-address-geocoding-proxy-design]]
 */
export interface GeocodeProperties {
  readonly place_id?: string;
  readonly formatted?: string;
  readonly address_line1?: string;
  readonly address_line2?: string;
  readonly street?: string;
  readonly housenumber?: string;
  readonly city?: string;
  readonly state?: string;
  readonly postcode?: string;
  readonly country?: string;
  /** ISO 3166-1 alpha-2, LOWERCASE on the wire — see `toAddress`. */
  readonly country_code?: string;
}

/** The GeoJSON envelope the default `format` returns. */
interface GeocodeFeatureCollection {
  readonly features?: readonly { readonly properties?: GeocodeProperties }[];
}

/** A suggestion as the field renders it: a label to show, an address to apply. */
export interface StreetSuggestion {
  readonly id: string;
  readonly label: string;
  readonly address: Address;
}

/** Fewer than this and the query matches half the country; nothing is sent. */
export const MIN_QUERY_LENGTH = 3;

const SUGGESTION_LIMIT = 5;

/**
 * CONTRACT: `country_code` arrives lowercase ("do") while `Address.country`
 * holds the uppercase form the Users service stores ("DO"). Passing the wire
 * value straight through writes a profile that disagrees with every address
 * typed by hand, and nothing rejects it.
 */
function toAddress(properties: GeocodeProperties): Address {
  const line1 = properties.address_line1 ?? properties.street ?? properties.formatted ?? '';
  return {
    line1,
    line2: null,
    city: properties.city ?? '',
    state: properties.state ?? '',
    postalCode: properties.postcode ?? '',
    country: (properties.country_code ?? '').toUpperCase(),
  };
}

/**
 * The same-origin `/geocode/` proxy; nginx appends the API key server-side.
 *
 * CONTRACT: Inject HttpClient directly, NEVER ApiClient, and keep the path
 * outside `/v1`. Under ApiClient the call leaves as `/v1/geocode/` and returns
 * the gateway's own 404 — and authInterceptor, which skips this only because
 * `gatewayPath()` is null, would attach our Cognito token to a third party.
 * See [[2026-09-06-address-geocoding-proxy-design]]
 */
@Injectable({ providedIn: 'root' })
export class GeocodeApi {
  private readonly http = inject(HttpClient);

  /**
   * CONTRACT: Degrade to an EMPTY list on every failure — 503 (key unset),
   * network error, malformed body. A checkout form must stay usable during a
   * geocoding outage, and an error surfaced here would block an order over a
   * convenience the buyer can do without.
   */
  suggest(query: string): Observable<StreetSuggestion[]> {
    return this.http
      .get<GeocodeFeatureCollection>('/geocode/', {
        params: {
          text: query,
          // CONTRACT: Send no country parameter. `filter=countrycode:` answers a
          // same-named place in that country instead of the real match, and
          // `bias=` ranks one country's streets above the buyer's own.
          limit: SUGGESTION_LIMIT,
        },
      })
      .pipe(
        map((body) => toSuggestions(body)),
        catchError(() => of([])),
      );
  }
}

/**
 * WHY: A suggestion with no street is unusable here — the field fills `line1`,
 * and an entry offering only a city would clear what the buyer already typed.
 */
function toSuggestions(body: GeocodeFeatureCollection): StreetSuggestion[] {
  const features = Array.isArray(body.features) ? body.features : [];
  return features
    .map((feature, index) => {
      const properties = feature.properties ?? {};
      const address = toAddress(properties);
      return {
        id: properties.place_id ?? `suggestion-${String(index)}`,
        label: properties.formatted ?? address.line1,
        address,
      };
    })
    .filter((suggestion) => suggestion.address.line1 !== '' && suggestion.label !== '');
}
