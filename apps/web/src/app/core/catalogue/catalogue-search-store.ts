import { computed } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';

/**
 * The catalogue search term, shared between the header and the catalogue page.
 *
 * CONTRACT: A store, not an input/output pair. The header renders in
 * `app-layout`, a SIBLING of `<router-outlet>`, so no binding reaches the page
 * from there. This is the same boundary CartStore and OverlayStore cross.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
export const CatalogueSearchStore = signalStore(
  { providedIn: 'root' },
  withState<{ query: string; expandedOnMobile: boolean }>({ query: '', expandedOnMobile: false }),
  withComputed(({ query }) => ({
    /** Trimmed and lower-cased once here rather than at each comparison. */
    normalized: computed(() => query().trim().toLowerCase()),
    isSearching: computed(() => query().trim().length > 0),
  })),
  withMethods((store) => ({
    setQuery: (query: string) => patchState(store, { query }),
    clear: () => patchState(store, { query: '', expandedOnMobile: false }),
    /** The mobile magnifier reveals the field instead of emitting into nothing. */
    toggleMobileField: () => patchState(store, { expandedOnMobile: !store.expandedOnMobile() }),
  })),
);
