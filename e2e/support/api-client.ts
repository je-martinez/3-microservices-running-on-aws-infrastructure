import { request, type APIRequestContext } from "@playwright/test";

// Drives the Users service directly, bypassing the gateway, with a faked x-user-id
// standing in for the authorizer's output. The gateway path — JWT authorizer, njs
// sub-extraction, nginx routing — is exercised by the "gateway" project through
// gateway-client.ts.
export async function apiClient(): Promise<APIRequestContext> {
  const baseURL = process.env.USERS_BASE_URL ?? "http://localhost:3000";
  return request.newContext({ baseURL, extraHTTPHeaders: { "X-E2E-Source": "true", "x-e2e-run-id": process.env.E2E_RUN_ID ?? "" } });
}

// Same idea, pointed at Orders (port 3001). Orders trusts `x-user-id` like Users does
// (only `GET /v1/health` is exempt) and resolves it as a Cognito sub over gRPC when it
// needs the internal `usr_` id. Users' `GetUserById` accepts a `usr_` id OR a Cognito
// sub, so register's `usr_` id works directly as `x-user-id` here.
export async function ordersClient(): Promise<APIRequestContext> {
  const baseURL = process.env.ORDERS_BASE_URL ?? "http://localhost:3001";
  return request.newContext({ baseURL, extraHTTPHeaders: { "X-E2E-Source": "true", "x-e2e-run-id": process.env.E2E_RUN_ID ?? "" } });
}

// Same idea, pointed at Tracking (host 3002 → container 8000). Tracking requires
// `x-user-id` on every route but `GET /v1/health` and the carrier PUT, storing it
// verbatim as `cognito_sub` — the ownership key its user-scoped reads filter by.
//
// CONTRACT: TRACKING_BASE_URL must stay a host-reachable fallback here. The same name
// exists in `.env.local.orders` as the CONTAINER-internal `http://tracking:8000`, so
// loading that file would fail every internal Tracking spec with a DNS error —
// playwright.config.ts deliberately does not. Nothing generates host-reachable base
// URLs; all three defaults just match the compose port mappings.
// See [[env-files]]
export async function trackingClient(): Promise<APIRequestContext> {
  const baseURL = process.env.TRACKING_BASE_URL ?? "http://localhost:3002";
  return request.newContext({ baseURL, extraHTTPHeaders: { "X-E2E-Source": "true", "x-e2e-run-id": process.env.E2E_RUN_ID ?? "" } });
}
