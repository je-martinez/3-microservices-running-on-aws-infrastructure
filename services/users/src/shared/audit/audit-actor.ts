// Semantic actor stamped into createdBy/updatedBy (and deletedBy) by the audit
// query extension (see `shared/db/prisma-extensions.ts` and
// `shared/audit/actor-context.ts`). Value format: `<source>:<action>`.
//
// All current write paths originate from the Users API itself (self-service
// endpoints and internal maintenance — not an admin console), so the source is
// uniformly `users_api`; the action distinguishes what produced the row. This
// replaces the previous practice of stamping a bare id/string, so the audit
// columns are self-describing and greppable (e.g. `users_api:register`) instead
// of opaque. Add members (and, if ever needed, new sources) when new callers
// appear — never widen it speculatively (YAGNI).
export enum AuditActor {
  Register = "users_api:register",
  RegisterPasswordless = "users_api:register_passwordless",
  UpdateProfile = "users_api:update_profile",
  // Three distinct password actions, not one: they answer different questions in
  // an audit trail. `password_reset_requested` stamps the minted code row,
  // `password_reset_confirmed` the consumption + forced-flag clear, and
  // `change_password` the authenticated self-service change at
  // PATCH /v1/users/me/password.
  PasswordResetRequested = "users_api:password_reset_requested",
  PasswordResetConfirmed = "users_api:password_reset_confirmed",
  ChangePassword = "users_api:change_password",
  IdentityCapture = "users_api:identity_capture",
  // DELETE /v1/users/me — the user erasing their own account. Distinct from
  // E2eCleanup, which also soft-deletes user rows: `deleted_by` records WHAT
  // produced the change, and "the user asked us to" is a different fact from
  // "the test harness swept it" — which is the whole reason this column stores a
  // source rather than an id.
  DeleteAccount = "users_api:delete_account",
  E2eCleanup = "users_api:e2e_cleanup",
}
