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
  // CONTRACT: This entry is what makes the route reachable — without it every call
  // 401s, and a teardown that ignores the response fails silently, leaving E2E users
  // uncleaned. The harness's global teardown has no user session, and it deletes by
  // TAG rather than by caller. The route only EXISTS under E2E_TESTING_ENABLED, so
  // this allowlist exposes nothing where the flag is off.
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
