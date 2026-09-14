import { doIf, exec, jsonPath, StringBody } from "@gatling.io/core";
import { http, status } from "@gatling.io/http";

/**
 * The notification-inbox steps: the bell's badge poll, the panel's list read, and the
 * mark-on-enter write. Shapes come from services/users/openapi.yaml, never guessed —
 * a wrong field name yields a 400 that reads as a service defect in the dashboards.
 * Steps assume a session that already ran the Users login, so the journeys compose.
 *
 * CONTRACT: Send NO `x-e2e-source` and NO `x-test-mode` header anywhere in this file.
 * The first tags rows for the E2E teardown to delete and the second makes trackings
 * self-advance; either one makes this traffic unrepresentative, and load data is meant
 * to persist like real data. See [[testing]]
 */

const authHeader = (session: { get: (k: string) => unknown }) =>
  `Bearer ${session.get("token")}`;

/**
 * The badge poll, and the highest-frequency call in this file: the bell sits on every
 * page, so a real client issues this far more often than it opens the panel. It is one
 * COUNT rather than a page fetch, which is the whole reason it exists as its own route.
 */
export const readUnreadCount = exec(
  http("GET /v1/notifications/unread-count")
    .get("v1/notifications/unread-count")
    .header("Authorization", authHeader)
    .check(status().is(200), jsonPath("$.unread_count").saveAs("unreadCount")),
);

/**
 * The panel open. Unpaginated by decision — the newest 50 with no date bound — so this
 * request's cost is bounded by that cap rather than by how long the account has
 * existed.
 */
export const openNotificationsPanel = exec(
  http("GET /v1/notifications")
    .get("v1/notifications")
    .header("Authorization", authHeader)
    .check(
      status().is(200),
      // Empty for a user whose welcome row has not yet been consumed, so the mark-read
      // step below must guard on it rather than assume ids are present.
      jsonPath("$.items[*].id").findAll().optional().saveAs("notificationIds"),
    ),
);

/** The Unread tab. Both counters ignore `filter`, so this costs the same three queries. */
export const openUnreadTab = exec(
  http("GET /v1/notifications?filter=unread")
    .get("v1/notifications?filter=unread")
    .header("Authorization", authHeader)
    .check(status().is(200)),
);

/**
 * Mark-on-enter, sending the ids the panel just read.
 *
 * CONTRACT: Keep the `doIf` guard. `notificationIds` is absent entirely until the
 * panel read saves it, and a single id matching no row answers 404 — an unguarded
 * call paints the run red for the endpoint behaving as designed.
 * See [[2026-09-10-in-app-notifications-design]]
 */
export const markNotificationsRead = exec(
  doIf((session) => session.contains("notificationIds")).then(
    exec(
      http("PATCH /v1/notifications/read")
        .patch("v1/notifications/read")
        .header("Authorization", authHeader)
        .body(
          StringBody((session) => {
            const ids = (session.get("notificationIds") as string[] | undefined) ?? [];
            // The endpoint caps the list at 50, the same cap the list itself uses, so a
            // full page always fits — the slice keeps that true if the cap ever moves.
            return JSON.stringify({ ids: ids.slice(0, 50) });
          }),
        )
        .asJson()
        .check(status().is(200)),
    ),
  ),
);

/** A 4xx on purpose, so the error panels carry signal instead of sitting empty. */
export const unauthorizedUnreadCount = exec(
  http("GET /v1/notifications/unread-count (no auth)")
    .get("v1/notifications/unread-count")
    .check(status().is(401)),
);
