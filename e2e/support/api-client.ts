import { request, type APIRequestContext } from "@playwright/test";

// The API Gateway (Floci) does not forward the request path for HTTP_PROXY
// integrations (see docs/lessons/floci-rds-apigw-limits.md), so E2E specs
// drive the users service directly instead of going through the gateway.
export async function apiClient(): Promise<APIRequestContext> {
  const baseURL = process.env.USERS_BASE_URL ?? "http://localhost:3000";
  return request.newContext({ baseURL, extraHTTPHeaders: { "X-E2E-Source": "true" } });
}
