import { computed } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';

import { User } from '../api/types';

interface SessionState {
  /** The signed-in user, or null when nobody is signed in. */
  user: User | null;
}

/**
 * CONTRACT: This holds session STATE only — no HTTP, no token persistence. The
 * tokens live in TokenStore and the calls live in the API services; a store
 * that fetches its own user turns every guard and interceptor into a caller
 * that can trigger a request, and the refresh interceptor would then recurse.
 */
export const SessionStore = signalStore(
  { providedIn: 'root' },
  withState<SessionState>({ user: null }),
  withComputed(({ user }) => ({
    /**
     * CONTRACT: Derive this from `user`, never store it as its own flag. Two
     * independent fields make "authenticated with no user" representable, and
     * a template reading `user()!.fullName` behind that flag throws at runtime.
     */
    isAuthenticated: computed(() => user() !== null),
  })),
  withMethods((store) => ({
    setUser: (user: User) => patchState(store, { user }),
    /** Drops the in-memory session. Clearing the persisted tokens is TokenStore's job. */
    clear: () => patchState(store, { user: null }),
  })),
);
