import type { FlowData } from "../../schema";

export const responseCache: FlowData = {
  title: "Shared response cache, shown on the Users profile read",
  subtitle: "Every service uses the same shape: interceptor read, fail open, invalidate after write",
  actors: [
    { id: "web", label: "Web app", kind: "external" },
    { id: "users", label: "Users service", kind: "compute", aws: "ecs" },
    { id: "cache", label: "Valkey cache", kind: "data", aws: "elasticache" },
    { id: "db", label: "Users Postgres", kind: "data", aws: "aurora" },
  ],
  steps: [
    { from: "web", to: "users", label: "Read profile", caption: "The interceptor runs first; with CACHE_ENABLED off it steps aside and sends no X-Cache" },
    { from: "users", to: "db", label: "Resolve user", caption: "The key carries the resolved user id, so the caller is looked up before the key exists" },
    { from: "users", to: "cache", label: "cache.get", caption: "A 50 ms timeout; an outage falls through to the database and answers BYPASS" },
    { from: "users", to: "web", label: "X-Cache: HIT", caption: "A hit returns the stored body plus X-Cache-TTL and the handler never runs" },
    { from: "users", to: "db", label: "Read profile", caption: "On a miss the handler runs as if no cache existed" },
    { from: "users", to: "cache", label: "cache.set", caption: "Only a 200 is stored, with a 5-minute TTL, and the response does not wait for it" },
    { from: "users", to: "web", label: "X-Cache: MISS", caption: "A miss carries no TTL header" },
    { from: "web", to: "users", label: "Update profile", caption: "A profile edit or password change alters what the cached body shows" },
    { from: "users", to: "db", label: "Persist", caption: "The write is committed first" },
    { from: "users", to: "cache", label: "Invalidate", caption: "Only after the write persists; earlier lets a concurrent read restore the stale body" },
  ],
};
