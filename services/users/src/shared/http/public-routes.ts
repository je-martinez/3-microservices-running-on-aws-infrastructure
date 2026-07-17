// Routes that do NOT require an x-user-id identity. The auth middleware
// (routes.ts onRequest hook) lets these through; everything else 401s on a
// missing header. Exact method+path match, except webhooks which match by prefix.
// Adding a public route means adding it here.
const EXACT: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/v1/health" },
  { method: "POST", path: "/v1/users/login" },
  { method: "POST", path: "/v1/users/register" },
  { method: "POST", path: "/v1/users/refresh" },
];

const PREFIX: ReadonlyArray<{ method: string; prefix: string }> = [
  { method: "POST", prefix: "/v1/webhooks/" },
];

export function isPublicRoute(method: string, routePath: string): boolean {
  const m = method.toUpperCase();
  if (EXACT.some((r) => r.method === m && r.path === routePath)) return true;
  if (PREFIX.some((r) => r.method === m && routePath.startsWith(r.prefix))) return true;
  return false;
}
