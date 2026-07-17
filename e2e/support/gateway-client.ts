import { request, type APIRequestContext } from "@playwright/test";

// Drives requests through the API gateway — the URL the end user hits. Unlike
// api-client.ts (direct service + faked x-user-id), this exercises the JWT
// authorizer → njs sub-extraction → nginx routing → service, end to end.
//
// API_GATEWAY_URL has a non-root path (Floci's
// `.../restapis/<id>/$default/_user_request_`). Playwright's APIRequestContext
// joins request paths onto baseURL using the WHATWG URL algorithm, where a
// LEADING SLASH replaces the entire baseURL path (so requests would land on
// Floci's S3 root instead of the gateway integration). The fix: normalize
// baseURL to end with a single trailing slash, and always issue requests with
// RELATIVE paths (no leading slash) so WHATWG appends onto the existing path
// instead of replacing it. `$default` is untouched — this is plain string
// concatenation, no URL re-encoding.
function normalizeBaseURL(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

export async function gatewayClient(token?: string): Promise<APIRequestContext> {
  const rawBaseURL = process.env.API_GATEWAY_URL;
  if (!rawBaseURL) {
    throw new Error("API_GATEWAY_URL is not set — run `make bootstrap` (it writes .env), then re-run.");
  }
  return request.newContext({
    baseURL: normalizeBaseURL(rawBaseURL),
    extraHTTPHeaders: token ? { Authorization: `Bearer ${token}` } : {},
  });
}
