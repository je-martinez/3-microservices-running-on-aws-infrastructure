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
  // The SQS consumer's writes. A distinct actor from every other member here
  // because these rows originate OUTSIDE a request — `deleted_by`/`created_by`
  // record WHAT produced the change, and "an event arrived" is a different fact
  // from "a user asked".
  NotificationCreated = "users_api:notification_created",
  NotificationsMarkedRead = "users_api:notifications_marked_read",
  // The payment-methods CQRS handlers: attach/detach/set-default all write
  // `StripePaymentMethod` rows on the caller's own behalf.
  PaymentMethodAttached = "users_api:payment_method_attached",
  PaymentMethodDetached = "users_api:payment_method_detached",
  PaymentMethodSetDefault = "users_api:payment_method_set_default",
  // The Stripe webhook's reconciliation writes — outside a request, like
  // NotificationCreated above, but sourced from Stripe rather than SQS.
  StripeWebhookReconcile = "users_api:stripe_webhook_reconcile",
}
