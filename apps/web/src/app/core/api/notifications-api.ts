import { inject, Injectable } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiClient } from '../http/api-client';
import { AppNotification, NotificationsPage } from './types';

/**
 * The notifications surface of services/users/openapi.yaml.
 *
 * CONTRACT: Paths carry NO "/v1" prefix — APP_CONFIG.apiGatewayUrl supplies it.
 * Writing "/v1/notifications" yields a request to "/v1/v1/notifications",
 * answered by the gateway's own 404 rather than by Users.
 * See [[2026-09-04-web-gateway-integration-design]]
 */

export type NotificationFilter = 'all' | 'unread' | 'read';

export interface MarkReadResult {
  updated: number;
  unreadCount: number;
}

/** The server's snake_case wire shapes, converted at this boundary and nowhere else. */
export interface NotificationWire {
  id: string;
  type: AppNotification['type'];
  title: string;
  body: string;
  metadata: AppNotification['metadata'];
  read_at: string | null;
  created_at: string;
}

interface PageWire {
  items: NotificationWire[];
  unread_count: number;
  window_total: number;
  window_days: number;
}

/** Exported so the socket client maps an inbound frame through the same function. */
export function toNotification(wire: NotificationWire): AppNotification {
  return {
    id: wire.id,
    type: wire.type,
    title: wire.title,
    body: wire.body,
    metadata: wire.metadata,
    readAt: wire.read_at,
    createdAt: wire.created_at,
  };
}

@Injectable({ providedIn: 'root' })
export class NotificationsApi {
  private readonly api = inject(ApiClient);

  /**
   * GET /notifications — the newest 50, newest first.
   *
   * CONTRACT: Deliberately unpaginated, and `windowTotal` is a 90-day count
   * WITHOUT the cap, so it can exceed `items.length`. That is why the counters
   * are separate: the pill stays exact when the cap truncates the list.
   * See [[2026-09-10-in-app-notifications-design]]
   */
  list(filter: NotificationFilter = 'all'): Observable<NotificationsPage> {
    return this.api.get<PageWire>('/notifications', { params: { filter } }).pipe(
      map((wire) => ({
        items: wire.items.map(toNotification),
        unreadCount: wire.unread_count,
        windowTotal: wire.window_total,
        windowDays: wire.window_days,
      })),
    );
  }

  /** GET /notifications/unread-count — the badge, without fetching a page. */
  unreadCount(): Observable<number> {
    return this.api
      .get<{ unread_count: number }>('/notifications/unread-count')
      .pipe(map((wire) => wire.unread_count));
  }

  /**
   * PATCH /notifications/read — one endpoint for entering the All screen,
   * "Mark all as read", and marking a single row.
   *
   * CONTRACT: Send a LIST, never a lone id. An empty list answers 200 with
   * `updated: 0`, and a multi-id call repeated answers `updated: 0` — but a
   * SINGLE id matching no row answers 404, so a single-id path turns an
   * already-read notification into an error state.
   * See [[2026-09-10-in-app-notifications-design]]
   */
  markRead(ids: readonly string[]): Observable<MarkReadResult> {
    return this.api
      .patch<{ updated: number; unread_count: number }>('/notifications/read', { ids })
      .pipe(map((wire) => ({ updated: wire.updated, unreadCount: wire.unread_count })));
  }
}
