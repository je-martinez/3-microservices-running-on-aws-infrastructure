import type { FlowData } from "../../schema";

export const usersAccountDeletionCascade: FlowData = {
  title: "Account deletion cascade",
  subtitle: "Cascade first, account last: a failed leg leaves the account alive to retry",
  actors: [
    { id: "web", label: "Web app", kind: "external" },
    { id: "users", label: "Users service", kind: "compute", aws: "ecs" },
    { id: "orders", label: "Orders service", kind: "compute", aws: "ecs" },
    { id: "tracking", label: "Tracking service", kind: "compute", aws: "ecs" },
    { id: "db", label: "Users Postgres", kind: "data", aws: "aurora" },
    { id: "cache", label: "Profile cache", kind: "data", aws: "elasticache" },
    { id: "cognito", label: "Cognito", kind: "edge", aws: "cognito" },
  ],
  steps: [
    { from: "web", to: "users", label: "Delete account", caption: "The signed-in user deletes their own account through a JWT-protected route" },
    { from: "users", to: "orders", label: "Cascade", caption: "An internal call with the internal API key; this route is not on the gateway" },
    { from: "orders", to: "orders", label: "Soft-delete", caption: "Orders, their details and carts are soft-deleted, matched by sub or user id" },
    { from: "users", to: "tracking", label: "Cascade", caption: "The same internal call to Tracking; empty identities are refused" },
    { from: "tracking", to: "tracking", label: "Soft-delete", caption: "Trackings and their history are soft-deleted; a repeat call is a no-op" },
    { from: "users", to: "db", label: "Stamp deletedAt", caption: "Only after both legs confirm is the users row soft-deleted; a failed leg is a 502" },
    { from: "users", to: "cache", label: "Invalidate", caption: "The cached profile is dropped; if the cache is down it expires on its TTL" },
    { from: "users", to: "cognito", label: "AdminDeleteUser", caption: "Last and best-effort: removing the sub frees the email for re-registration" },
    { from: "users", to: "web", label: "204", caption: "No USER_DELETED event; old data stays bound to the old user id and sub" },
  ],
};
