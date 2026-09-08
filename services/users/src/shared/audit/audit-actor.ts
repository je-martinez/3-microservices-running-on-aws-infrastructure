// CONTRACT: Stamp a semantic `<source>:<action>` value, never a bare id — that is
// what makes the audit columns greppable (`users_api:register`) rather than opaque.
// Every current write path is the Users API itself, so the source is uniformly
// `users_api`. Add members when new callers appear, never speculatively.
// See [[audit-fields]]
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
