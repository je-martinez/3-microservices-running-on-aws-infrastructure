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

/**
 * Clears `kind` if it is already the open overlay, otherwise selects it.
 * The `OverlayKind` return annotation is load-bearing: without it the ternary
 * widens to `string` and `patchState` rejects the updater.
 */
function toggled(kind: OverlayKind): (state: { active: OverlayKind }) => { active: OverlayKind } {
  return (state) => ({ active: state.active === kind ? null : kind });
}

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
    /**
     * CONTRACT: The bell and profile controls TOGGLE — a plain open leaves the
     * second click on the same button a no-op, with the panel covering the
     * control meant to dismiss it. Compare against `kind`, never negate a
     * boolean: opening one panel while a DIFFERENT one is up must switch
     * (bell → profile shows the menu), which only assignment preserves.
     * See [[angular-component-authoring]]
     */
    toggleAccountMenu: () => patchState(store, toggled('account-menu')),
    toggleNotifications: () => patchState(store, toggled('notifications')),
    close: () => patchState(store, { active: null }),
  })),
);
