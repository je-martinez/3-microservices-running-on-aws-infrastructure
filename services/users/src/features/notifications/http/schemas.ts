import { z } from "zod/v4";
import { NOTIFICATIONS_LIMIT, WINDOW_DAYS } from "../queries/list-notifications.ts";

/**
 * CONTRACT: The wire shape is snake_case, unlike the domain type's camelCase. The
 * web binds to these names, so renaming one is a breaking API change.
 */
export const NotificationSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  // `metadata` is a deliberately open bag whose keys vary by variant (a WELCOME
  // row has no status and no order_id); pinning it here would reject a new
  // variant's key before the web could read it.
  metadata: z.record(z.string(), z.unknown()),
  read_at: z.string().nullable(),
  created_at: z.string(),
});

export const NotificationsPageSchema = z.object({
  items: z.array(NotificationSchema),
  // Separate from `items.length` on purpose: the count pill must stay exact when
  // the 50 cap truncates the list.
  unread_count: z.number().int().nonnegative(),
  // A 90-day count WITHOUT the cap, so it can exceed items.length.
  window_total: z.number().int().nonnegative(),
  window_days: z.literal(WINDOW_DAYS),
});

export const UnreadCountSchema = z.object({
  unread_count: z.number().int().nonnegative(),
});

/** `filter` defaults to `all`; anything outside the three values is a 400. */
export const NotificationFilterQuerySchema = z.object({
  filter: z.enum(["all", "unread", "read"]).default("all"),
});

/**
 * CONTRACT: A LIST of ids, capped at the same 50 as the list. An empty array is
 * VALID and answers 200 with `updated: 0` — arriving with nothing unread is the
 * normal case for the All screen's mark-on-enter.
 */
export const MarkReadInputSchema = z.object({
  ids: z.array(z.string().min(1)).max(NOTIFICATIONS_LIMIT),
});

export const MarkReadResultSchema = z.object({
  updated: z.number().int().nonnegative(),
  unread_count: z.number().int().nonnegative(),
});

// Named components rather than inline anonymous schemas, so the generated spec
// shows proper models in Apidog. A request body's component gains an "Input"
// suffix, so id "MarkRead" yields "MarkReadInput". See [[openapi-specs]]
z.globalRegistry.add(NotificationSchema, { id: "Notification" });
z.globalRegistry.add(NotificationsPageSchema, { id: "NotificationsPage" });
z.globalRegistry.add(UnreadCountSchema, { id: "UnreadCount" });
z.globalRegistry.add(MarkReadResultSchema, { id: "MarkReadResult" });
z.globalRegistry.add(MarkReadInputSchema, { id: "MarkRead" });
