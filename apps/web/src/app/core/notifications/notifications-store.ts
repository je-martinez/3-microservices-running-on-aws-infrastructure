import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';

import { NotificationFilter, NotificationsApi } from '../api/notifications-api';
import { AppNotification } from '../api/types';
import { ApiError } from '../http/api-client';

interface NotificationsState {
  items: readonly AppNotification[];
  /** The server's exact unread total, independent of the active filter. */
  unreadCount: number;
  /** A 90-day count without the list cap, so it may exceed items.length. */
  windowTotal: number;
  filter: NotificationFilter;
  loading: boolean;
  error: string | null;
  /**
   * Ids that were unread when the All screen was entered.
   *
   * CONTRACT: The ARRIVAL HIGHLIGHT, and CLIENT-ONLY — the server has no notion
   * of "read but still highlighted". Entering marks everything read while these
   * ids keep their dot and `bg-surface-subtle` for the rest of the visit, which
   * is what reconciles the frame's three unread rows and its "Mark all as read"
   * button with mark-on-enter. Cleared on leave, so a reload renders them read.
   * See [[2026-09-10-in-app-notifications-design]]
   */
  highlighted: readonly string[];
}

const INITIAL: NotificationsState = {
  items: [],
  unreadCount: 0,
  windowTotal: 0,
  filter: 'all',
  loading: false,
  error: null,
  highlighted: [],
};

const UNREACHABLE = 'We could not reach your notifications. Check your connection and try again.';
const FAILED = 'We could not update your notifications. Please try again.';

function messageFor(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 0) return UNREACHABLE;
  if (error.status >= 500) return fallback;
  return error.detail;
}

/** Stamps `readAt` on the marked rows, leaving the rest as held. */
function withReadAt(
  items: readonly AppNotification[],
  ids: readonly string[],
  readAt: string,
): readonly AppNotification[] {
  const marked = new Set(ids);
  return items.map((item) => (marked.has(item.id) ? { ...item, readAt } : item));
}

function matchesFilter(item: AppNotification, filter: NotificationFilter): boolean {
  if (filter === 'unread') return item.readAt === null;
  if (filter === 'read') return item.readAt !== null;
  return true;
}

/**
 * The notification inbox and the header badge.
 *
 * CONTRACT: `unreadCount` always comes from the SERVER — a list response, a
 * mark-read response, or a socket frame — never from counting `items` or adding
 * one locally. The list is capped at 50 while the count is not, so a local
 * derivation understates the badge the moment the cap bites.
 * See [[2026-09-10-in-app-notifications-design]]
 */
export const NotificationsStore = signalStore(
  { providedIn: 'root' },
  withState<NotificationsState>(INITIAL),
  withComputed(({ items, filter, unreadCount, highlighted }) => ({
    /**
     * CONTRACT: Filter the HELD items as well as asking the server for a filter.
     * A socket frame lands in `items` whatever the active tab is, so a template
     * rendering `items()` directly shows an unread row under the Read tab.
     */
    visible: computed(() => items().filter((item) => matchesFilter(item, filter()))),
    hasUnread: computed(() => unreadCount() > 0),
    highlightedIds: computed(() => new Set(highlighted())),
  })),
  withMethods((store) => {
    const api = inject(NotificationsApi);

    /**
     * CONTRACT: Ids whose mark-read is in flight, held separately from
     * `highlighted` because that one commits only once the PATCH lands. Without
     * this, a remount re-entering — or a second "Mark all as read" click — sends
     * a SECOND PATCH for the same ids, since they read unread until it lands.
     */
    const marking = new Set<string>();

    /** The held rows the server still considers unread. */
    function unreadIds(): string[] {
      return store
        .items()
        .filter((item) => item.readAt === null)
        .map((item) => item.id);
    }

    /**
     * CONTRACT: Guards the list endpoint the way `marking` guards the PATCH. A
     * filter pill is a plain button, so without this one held click issues a GET
     * per frame — the reader holds an open tap on the gateway.
     */
    let listing = false;

    async function fetch(filter: NotificationFilter): Promise<void> {
      if (listing) return;
      listing = true;
      patchState(store, { filter, loading: true, error: null });
      try {
        const page = await firstValueFrom(api.list(filter));
        patchState(store, {
          items: page.items,
          unreadCount: page.unreadCount,
          windowTotal: page.windowTotal,
        });
      } catch (error: unknown) {
        patchState(store, { error: messageFor(error, UNREACHABLE) });
      } finally {
        listing = false;
        patchState(store, { loading: false });
      }
    }

    /**
     * Marks `ids` read and stamps them locally, answering whether it landed.
     *
     * CONTRACT: Return early on an empty list. The server answers 200 with
     * `updated: 0`, so the request is harmless, but every screen entry with
     * nothing unread would spend a round trip on it.
     * See [[2026-09-10-in-app-notifications-design]]
     */
    async function markRead(ids: readonly string[]): Promise<boolean> {
      if (ids.length === 0) return true;
      try {
        const result = await firstValueFrom(api.markRead(ids));
        patchState(store, {
          items: withReadAt(store.items(), ids, new Date().toISOString()),
          unreadCount: result.unreadCount,
          error: null,
        });
        return true;
      } catch (error: unknown) {
        patchState(store, { error: messageFor(error, FAILED) });
        return false;
      }
    }

    return {
      /** Reads the newest page under the active filter. Safe on every open. */
      load: (filter: NotificationFilter = store.filter()): Promise<void> => fetch(filter),

      /**
       * CONTRACT: Re-selecting the ACTIVE filter is a no-op, ahead of `fetch`'s
       * in-flight guard. A pill the reader keeps clicking is the common case,
       * and it must cost nothing once the first request has landed.
       */
      setFilter: (filter: NotificationFilter): Promise<void> =>
        filter === store.filter() ? Promise.resolve() : fetch(filter),

      markRead: async (ids: readonly string[]): Promise<void> => {
        await markRead(ids);
      },

      /**
       * CONTRACT: Marks every unread row in ONE request, skipping ids already
       * in flight. Rows stay unread until the PATCH lands, so a second click
       * otherwise re-sends the same ids — a held button, one request per frame.
       */
      markAllRead: async (): Promise<void> => {
        const fresh = unreadIds().filter((id) => !marking.has(id));
        if (fresh.length === 0) return;

        fresh.forEach((id) => marking.add(id));
        try {
          await markRead(fresh);
        } finally {
          fresh.forEach((id) => marking.delete(id));
        }
      },

      /**
       * Marks everything currently unread as read, keeping those rows highlighted.
       *
       * CONTRACT: Idempotent against a double call. Angular can remount the
       * screen, and the guard here plus the server's `read_at IS NULL` clause
       * both hold — belt and braces, because either alone still double-counts
       * in the UI. See [[2026-09-10-in-app-notifications-design]]
       */
      enterAllScreen: async (): Promise<void> => {
        const held = new Set(store.highlighted());
        const fresh = unreadIds().filter((id) => !held.has(id) && !marking.has(id));
        if (fresh.length === 0) return;

        fresh.forEach((id) => marking.add(id));
        try {
          // CONTRACT: Commit the highlight only once the PATCH lands. Holding
          // it on a failure makes the retry on remount skip those ids, leaving
          // rows the user has read unread forever and the badge above zero.
          if (!(await markRead(fresh))) return;
          patchState(store, { highlighted: [...store.highlighted(), ...fresh] });
        } finally {
          fresh.forEach((id) => marking.delete(id));
        }
      },

      /** Ends the visit, so the next entry renders those rows as read. */
      leaveAllScreen: (): void => patchState(store, { highlighted: [] }),

      isHighlighted: (id: string): boolean => store.highlightedIds().has(id),

      /**
       * Applies an inbound NOTIFICATION_CREATED frame.
       *
       * CONTRACT: Take `unreadCount` from the SERVER's value, never a local
       * increment — the frame carries it precisely so the badge cannot drift,
       * and a local +1 doubles the badge on a reconnect that replays a frame.
       * See [[2026-09-10-in-app-notifications-design]]
       */
      receive: (notification: AppNotification, unreadCount: number): void => {
        const present = store.items().some((item) => item.id === notification.id);
        patchState(store, {
          items: present ? store.items() : [notification, ...store.items()],
          unreadCount,
        });
      },
    };
  }),
);
