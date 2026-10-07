import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: drawn as it runs in local dev: Users in Docker Compose, Valkey (ElastiCache) on Floci
// outside the VPC (no subnet group), Users Postgres (RDS) in module.networking's subnets. Replies
// reuse the request edge. Sources: services/users/src/shared/cache, infra/modules/{networking,redis}.
export const responseCache: z.input<typeof AwsDiagramData> = {
  title: "Shared response cache, shown on the Users profile read",
  subtitle: "Local dev. Every service uses the same shape: interceptor read, fail open, invalidate after write",
  direction: "RIGHT",
  groups: [
    { id: "compose", kind: "generic", label: "Docker Compose: services" },
    { id: "floci", kind: "local-floci", label: "Floci (:4566)" },
    { id: "vpc", kind: "vpc", label: "VPC 10.0.0.0/16", parent: "floci" },
    { id: "subnets", kind: "public-subnet", label: "Subnets a + b", parent: "vpc" },
  ],
  nodes: [
    { id: "web", label: "Web app", sublabel: "browser", icon: "client" },
    { id: "users", label: "Users service", icon: "server", group: "compose" },
    { id: "cache", label: "Valkey cache", sublabel: "ElastiCache", icon: "elasticache", group: "floci" },
    { id: "db", label: "Users Postgres", sublabel: "RDS", icon: "rds", group: "subnets" },
  ],
  edges: [
    { id: "web-users", from: "web", to: "users", label: "via API Gateway" },
    { id: "users-db", from: "users", to: "db" },
    { id: "users-cache", from: "users", to: "cache" },
  ],
  steps: [
    { edges: ["web-users"], caption: "The interceptor runs first; with CACHE_ENABLED off it steps aside and sends no X-Cache" },
    { edges: ["users-db"], caption: "The key carries the resolved user id, so the caller is looked up before the key exists" },
    { edges: ["users-cache"], caption: "A 50 ms timeout; an outage falls through to the database and answers BYPASS" },
    { edges: ["web-users"], caption: "A hit returns the stored body plus X-Cache-TTL and the handler never runs" },
    { edges: ["users-db"], caption: "On a miss the handler runs as if no cache existed" },
    { edges: ["users-cache"], caption: "Only a 200 is stored, with a 5-minute TTL, and the response does not wait for it" },
    { edges: ["web-users"], caption: "A miss carries no TTL header" },
    { edges: ["web-users"], caption: "A profile edit or password change alters what the cached body shows" },
    { edges: ["users-db"], caption: "The write is committed first" },
    { edges: ["users-cache"], caption: "Only after the write persists; earlier lets a concurrent read restore the stale body" },
  ],
};
