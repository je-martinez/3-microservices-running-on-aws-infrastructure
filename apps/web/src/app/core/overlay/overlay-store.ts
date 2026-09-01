import { computed } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';

/**
 * Which overlay covers the current route, if any.
 * CONTRACT: Keep this one discriminated value rather than a boolean per panel.
 * Every frame wraps a `Page` plus exactly ONE overlay; independent booleans
 * would make two-panels-open representable, a state no frame defines.
 * See [[angular-component-authoring]]
 */
export type OverlayKind = 'cart' | 'cart-payment' | 'account-menu' | 'notifications' | null;

/**
 * CONTRACT: Do NOT add the toast to OverlayKind. It is transient, carries no
 * Scrim, and may appear WHILE the cart is open; folding it into `active` makes
 * showing a toast close the cart. It lives as its own independent signal.
 * See [[angular-component-authoring]]
 */

export const OverlayStore = signalStore(
  { providedIn: 'root' },
  withState<{ active: OverlayKind }>({ active: null }),
  withComputed(({ active }) => ({
    isOpen: computed(() => active() !== null),
    /** The Scrim is present for the cart frames; the menu/panel frames have none. */
    hasScrim: computed(() => active() === 'cart' || active() === 'cart-payment'),
  })),
  withMethods((store) => ({
    openCart: () => patchState(store, { active: 'cart' }),
    openCartPayment: () => patchState(store, { active: 'cart-payment' }),
    openAccountMenu: () => patchState(store, { active: 'account-menu' }),
    openNotifications: () => patchState(store, { active: 'notifications' }),
    close: () => patchState(store, { active: null }),
  })),
);
