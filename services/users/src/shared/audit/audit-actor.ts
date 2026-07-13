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
  UpdateProfile = "users_api:update_profile",
  IdentityCapture = "users_api:identity_capture",
  E2eCleanup = "users_api:e2e_cleanup",
}
