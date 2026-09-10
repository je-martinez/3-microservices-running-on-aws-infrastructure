import { request, type APIRequestContext } from "@playwright/test";

// Drives requests through the API gateway — the URL the end user hits, exercising the
// JWT authorizer → njs sub-extraction → nginx routing → service end to end.
//
// CONTRACT: Keep baseURL ending in a single trailing slash and issue every request
// path RELATIVE (no leading slash). API_GATEWAY_URL has a non-root path, and under
// WHATWG URL joining a LEADING SLASH replaces it entirely — the request then lands on
// Floci's S3 root instead of the gateway integration. See [[testing]]
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
    extraHTTPHeaders: {
      // CONTRACT: Keep this header on the gateway contexts too. It tags rows as "E2E
      // Source", which is the only thing global teardown deletes by — without it the
      // majority of the suite's rows are invisible to cleanup. Harmless in production:
      // each service honors it only under its own E2E_TESTING_ENABLED.
      "X-E2E-Source": "true",
      // Attributes every email this request causes to THIS run, so the fixture
      // collection is queryable per invocation rather than blindly across workers and
      // reruns. Minted once in global-setup. Same production-safety property as above:
      // honored only under E2E_TESTING_ENABLED, with the Cognito trigger re-validating
      // the shape independently.
      "x-e2e-run-id": process.env.E2E_RUN_ID ?? "",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}
