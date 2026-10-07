import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: drawn as local dev. The three services run in Docker Compose; both RDS instances sit in
// the VPC subnets on Floci, ElastiCache and Cognito outside the VPC. Orders and Tracking soft-delete
// in the shared RDS MySQL. Sources: services/users/src/users/commands/delete-account.command.ts,
// services/orders/.../DeleteOrdersByUserService.cs, services/tracking-go/internal/{app,adapter}.
export const usersAccountDeletionCascade: z.input<typeof AwsDiagramData> = {
  title: "Account deletion cascade",
  subtitle: "Cascade first, account last: a failed leg leaves the account alive to retry (local dev)",
  direction: "RIGHT",
  groups: [
    { id: "compose", kind: "generic", label: "Docker Compose" },
    { id: "floci", kind: "local-floci", label: "Floci (:4566)" },
    { id: "vpc", kind: "vpc", label: "VPC 10.0.0.0/16", parent: "floci" },
    { id: "subnets", kind: "public-subnet", label: "Subnets a + b", parent: "vpc" },
  ],
  nodes: [
    { id: "web", label: "Web app", sublabel: "browser", icon: "client" },
    { id: "users", label: "Users service", icon: "server", group: "compose" },
    { id: "orders", label: "Orders service", icon: "server", group: "compose" },
    { id: "tracking", label: "Tracking service", icon: "server", group: "compose" },
    { id: "mysql", label: "RDS MySQL", sublabel: "orders + tracking", icon: "rds", group: "subnets" },
    { id: "db", label: "Users Postgres", sublabel: "RDS", icon: "rds", group: "subnets" },
    { id: "cache", label: "Profile cache", sublabel: "ElastiCache", icon: "elasticache", group: "floci" },
    { id: "cognito", label: "Cognito", icon: "cognito", group: "floci" },
  ],
  edges: [
    { id: "web-users", from: "web", to: "users", label: "delete account" },
    { id: "users-orders", from: "users", to: "orders", label: "cascade" },
    { id: "orders-mysql", from: "orders", to: "mysql", label: "soft-delete" },
    { id: "users-tracking", from: "users", to: "tracking", label: "cascade" },
    { id: "tracking-mysql", from: "tracking", to: "mysql", label: "soft-delete" },
    { id: "users-db", from: "users", to: "db", label: "stamp deletedAt" },
    { id: "users-cache", from: "users", to: "cache", label: "invalidate" },
    { id: "users-cognito", from: "users", to: "cognito", label: "AdminDeleteUser" },
  ],
  steps: [
    { edges: ["web-users"], caption: "The signed-in user deletes their own account through a JWT-protected route" },
    { edges: ["users-orders"], caption: "An internal call with the internal API key; this route is not on the gateway" },
    { edges: ["orders-mysql"], caption: "Orders, their details and carts are soft-deleted, matched by sub or user id" },
    { edges: ["users-tracking"], caption: "The same internal call to Tracking; empty identities are refused" },
    { edges: ["tracking-mysql"], caption: "Trackings and their history are soft-deleted; a repeat call is a no-op" },
    { edges: ["users-db"], caption: "Only after both legs confirm is the users row soft-deleted; a failed leg is a 502" },
    { edges: ["users-cache"], caption: "The cached profile is dropped; if the cache is down it expires on its TTL" },
    { edges: ["users-cognito"], caption: "Last and best-effort: removing the sub frees the email for re-registration" },
    { edges: ["web-users"], caption: "No USER_DELETED event; old data stays bound to the old user id and sub" },
  ],
};
