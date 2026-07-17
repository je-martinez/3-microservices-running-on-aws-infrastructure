import { request, type APIRequestContext } from "@playwright/test";

// Drives the users service directly (bypassing the gateway) so these specs
// exercise the service in isolation, with a faked x-user-id standing in for
// the authorizer's output. The gateway path IS exercised end-to-end — JWT
// authorizer, njs sub-extraction, nginx routing — by the "gateway" project via
// gateway-client.ts. Floci's HTTP_PROXY integration does forward the request
// path when the integration URI carries the route param (see the {orderId}
// fix); it was not dropping paths in general.
export async function apiClient(): Promise<APIRequestContext> {
  const baseURL = process.env.USERS_BASE_URL ?? "http://localhost:3000";
  return request.newContext({ baseURL, extraHTTPHeaders: { "X-E2E-Source": "true" } });
}
