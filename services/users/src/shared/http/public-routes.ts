// Routes that do NOT require an x-user-id identity. The auth middleware
// (routes.ts onRequest hook) lets these through; everything else 401s on a
// missing header. Exact method+path match, except webhooks which match by prefix.
// Adding a public route means adding it here.
const EXACT: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/v1/health" },
  { method: "POST", path: "/v1/users/login" },
  { method: "POST", path: "/v1/users/register" },
  { method: "POST", path: "/v1/users/register/passwordless" },
  { method: "POST", path: "/v1/users/refresh" },
  // Both halves of the OTP login flow are pre-authentication by definition —
  // the caller has no token yet, which is the whole point of the flow.
  { method: "POST", path: "/v1/users/otp/start" },
  { method: "POST", path: "/v1/users/otp/verify" },
  // Both halves of the password reset are pre-authentication by definition: a
  // user who has forgotten their password cannot hold a token. Note the SIBLING
  // route PATCH /v1/users/me/password is deliberately NOT here — that one is the
  // authenticated change, and it must 401 without an identity.
  { method: "POST", path: "/v1/users/password/forgot" },
  { method: "POST", path: "/v1/users/password/confirm" },
  // The E2E harness's global teardown, which runs once with no user session and
  // so cannot send an x-user-id. It deletes by TAG ("E2E Source"), never by
  // caller, so an identity would tell it nothing anyway.
  //
  // This entry is what makes the route reachable at all: it 401'd every call
  // since it was written, and because the old teardown ignored the response,
  // that failed silently — E2E users were never actually cleaned up. The route
  // itself only EXISTS under E2E_TESTING_ENABLED (see routes.ts), which is what
  // keeps it off a production runtime; being on this allowlist does not expose
  // it anywhere the flag is off.
  { method: "DELETE", path: "/v1/users/e2e-cleanup" },
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
