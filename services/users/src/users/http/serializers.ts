import type { User } from "#features/users/domain/user";
import type { Notification } from "#features/notifications/domain/notification";

// `User` (the domain shape returned by commands/queries) carries real `Date`
// fields; `UserSchema` documents the wire shape as ISO strings (see
// schemas.ts). Convert at the HTTP boundary — Zod's serializer strictly
// rejects a `Date` against `z.string()`, it does not coerce.
export function serializeUser(user: User) {
  return {
    ...user,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    deletedAt: user.deletedAt ? user.deletedAt.toISOString() : null,
  };
}

// `Notification` carries real `Date` fields; the wire shape is snake_case with ISO
// strings. Convert at the HTTP boundary — Zod's serializer strictly REJECTS a Date
// against z.string(), it does not coerce.
export function serializeNotification(notification: Notification) {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    // Spread into a plain record: `NotificationMetadata` is an interface, which
    // carries no index signature and so does not assign to the schema's
    // z.record(). The keys are unchanged.
    metadata: { ...notification.metadata } as Record<string, unknown>,
    read_at: notification.readAt ? notification.readAt.toISOString() : null,
    created_at: notification.createdAt.toISOString(),
  };
}

// Extracts the raw token from an `Authorization: Bearer <token>` header, or null
// when the header is absent or not a Bearer one. The scheme match is
// case-insensitive because HTTP auth schemes are, and a client sending `bearer`
// holds a perfectly valid token.
// WARNING: The return value is a credential — pass it on, never log it.
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer[ ]+(.+)$/i.exec(header?.trim() ?? "");
  return match?.[1]?.trim() || null;
}
