// The credential for `PUT /v1/trackings/{orderId}/status`, the one Tracking route not
// behind the Cognito authorizer — its gateway route is `auth = false`, so the request
// carries no Bearer token and no `x-user-id`, and the service validates this key
// itself in constant time.
//
// CONTRACT: Read the key from the environment, NEVER hardcode it. An inlined key both
// commits a credential and keeps passing after the generated one changes, asserting
// against its own stale copy. `make env-file` writes the real value.
// CONTRACT: Do NOT substitute GRPC_API_KEY. It shares the `x-api-key` header spelling
// but is a separate secret in a separate trust domain. See [[env-files]]
export function carrierApiKey(): string {
  const key = process.env.TRACKING_CARRIER_API_KEY;
  if (!key) {
    throw new Error(
      "TRACKING_CARRIER_API_KEY is not set — it is generated into .env.local.tracking " +
        "by `make env-file`, which playwright.config.ts reads. Run `make env-file` from " +
        "the repo root, then re-run the E2E suite.",
    );
  }
  return key;
}

// Headers for an authenticated carrier call. A helper rather than a bare string so
// no spec has to remember the header NAME either.
export function carrierHeaders(): Record<string, string> {
  return { "x-api-key": carrierApiKey() };
}
