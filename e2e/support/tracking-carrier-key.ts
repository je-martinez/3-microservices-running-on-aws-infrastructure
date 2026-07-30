// The credential for `PUT /v1/trackings/{orderId}/status`, the one Tracking route
// that is NOT behind the Cognito authorizer. Its gateway route is declared
// `auth = false` (infra/modules/api-gateway/main.tf), so the request carries no
// Bearer token and no `x-user-id` at all — the service itself validates this key,
// in constant time, and answers 401 for a wrong OR absent one
// (services/tracking/src/shared/http/carrier_auth.py).
//
// Read from the environment, never hardcoded: the real value is generated into
// `.env.local.tracking` by `make env-file`, and playwright.config.ts copies just
// this one variable out of that file. A test that inlined the key would (a) commit
// a credential and (b) keep passing after the generated key changed, by asserting
// against its own stale copy rather than the service's actual expectation.
//
// Header name is `x-api-key` — the same spelling the internal gRPC key uses, with a
// different value on a different transport (see CARRIER_API_KEY_HEADER in
// carrier_auth.py). Do not substitute GRPC_API_KEY here: they are separate secrets
// in separate trust domains (services/tracking/CLAUDE.md §5a).
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
