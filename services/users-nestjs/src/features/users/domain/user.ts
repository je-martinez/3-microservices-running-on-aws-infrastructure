export interface UserRow {
  id: string;
  email: string;
  fullName: string;
  // Nullable: a users row exists before its Cognito identity is captured (see
  // the webhook capture path). Present on every raw row from
  // `findByIdOrCognitoSub` (a select-less findFirst), so the gRPC surface can
  // expose it as `cognito_sub`.
  cognitoSub: string | null;
  address: unknown | null;
  phoneNumber: string | null;
  tags: string[];
  // Read-only at the API boundary: exposed in responses, never accepted in a
  // request body. Set by the registration path (PASSWORD by default), not by
  // any update.
  authType: "PASSWORD" | "PASSWORDLESS";
  // Read-only at the API boundary, like `authType`: exposed on GET /v1/users/me
  // so the FRONTEND knows it must route the user through
  // PATCH /v1/users/me/password, never accepted from a request body. It is
  // cleared by the two commands that set a password (confirm-password-reset,
  // change-password) — nothing else writes it.
  mustChangePassword: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedBy: string | null;
  updatedAt: Date;
  deletedBy: string | null;
  deletedAt: Date | null;
}

export interface User extends UserRow {
  isDeleted: boolean;
}

// `isDeleted` is computed by the Prisma client extension's `result` block
// (see [[soft-delete]] and `shared/db/prisma-extensions.ts`) directly on rows
// returned by the db client. `toDomain` derives it the same way (`deletedAt
// !== null`) so it stays correct for any `UserRow` regardless of whether it
// already carries a computed `isDeleted` (e.g. rows built by hand in tests).
export function toDomain(row: UserRow): User {
  return { ...row, isDeleted: row.deletedAt !== null };
}
