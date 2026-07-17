import { request, type APIRequestContext } from "@playwright/test";

// Drives requests through the API gateway — the URL the end user hits. Unlike
// api-client.ts (direct service + faked x-user-id), this exercises the JWT
// authorizer → njs sub-extraction → nginx routing → service, end to end.
export async function gatewayClient(token?: string): Promise<APIRequestContext> {
  const baseURL = process.env.API_GATEWAY_URL;
  if (!baseURL) {
    throw new Error("API_GATEWAY_URL is not set — run `make bootstrap` (it writes .env), then re-run.");
  }
  return request.newContext({
    baseURL,
    extraHTTPHeaders: token ? { Authorization: `Bearer ${token}` } : {},
  });
}
