import { computed } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';

/**
 * Which overlay covers the current route, if any.
 *
 * The design's frames — Home — Cart Open (wevx6), Home — Account Menu (H2A9g),
 * Home — Notifications (mSssa) — each wrap a `Page` plus ONE overlay, never two.
 * A single discriminated value makes that exclusivity unrepresentable-otherwise;
 * four independent booleans would allow states the design does not define.
 */
export type OverlayKind = 'cart' | 'cart-payment' | 'account-menu' | 'notifications' | null;

/**
 * The toast is deliberately NOT an OverlayKind.
 *
 * The other four are mutually exclusive panels: the design never shows two at
 * once, which is what the single `active` signal encodes. A toast is different
 * in kind — it is transient, carries no Scrim (verified: only the three cart
 * frames have one), and can legitimately appear WHILE the cart is open. Folding
 * it into `active` would make "toast" close the cart, which no frame implies.
 * Task 11 models it as its own independent signal.
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
