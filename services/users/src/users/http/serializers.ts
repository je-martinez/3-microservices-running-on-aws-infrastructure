import type { User } from "#features/users/domain/user";
import type { Notification } from "#features/notifications/domain/notification";

// `User` carries real `Date` fields (converted here to ISO strings, see
// schemas.ts) and internal-only columns like `stripeCustomerId`.
// CONTRACT: List fields explicitly — never `...user` — or an internal column
// reaches GET/PATCH /v1/users/me the moment it is added to the Prisma model.
export function serializeUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    cognitoSub: user.cognitoSub,
    address: user.address,
    phoneNumber: user.phoneNumber,
    tags: user.tags,
    authType: user.authType,
    mustChangePassword: user.mustChangePassword,
    createdBy: user.createdBy,
    createdAt: user.createdAt.toISOString(),
    updatedBy: user.updatedBy,
    updatedAt: user.updatedAt.toISOString(),
    deletedBy: user.deletedBy,
    deletedAt: user.deletedAt ? user.deletedAt.toISOString() : null,
    isDeleted: user.isDeleted,
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
