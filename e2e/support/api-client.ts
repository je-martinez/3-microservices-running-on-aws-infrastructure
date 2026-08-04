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

// Same idea, pointed at the Orders service directly (port 3001). Orders trusts
// `x-user-id` exactly like Users does (see CallerContextMiddleware /
// PublicRoutes.IsPublic — only `GET /v1/health` is exempt), and resolves that
// header as a Cognito sub via gRPC to Users for any endpoint that needs the
// internal `usr_` id (order creation, ownership checks). Users' gRPC
// `GetUserById` resolves by `usr_` id OR Cognito sub (`findByIdOrCognitoSub`),
// so the `usr_` id returned by `POST /v1/users/register` works directly as
// `x-user-id` here too — verified live against the running stack.
export async function ordersClient(): Promise<APIRequestContext> {
  const baseURL = process.env.ORDERS_BASE_URL ?? "http://localhost:3001";
  return request.newContext({ baseURL, extraHTTPHeaders: { "X-E2E-Source": "true" } });
}

// Same idea, pointed at the Tracking service directly (host port 3002 → container
// 8000, see docker-compose.yml). Tracking requires `x-user-id` on every route
// except `GET /v1/health` and the carrier PUT; the header carries a Cognito sub at
// the gateway, and the service stores it verbatim as `cognito_sub` — the ownership
// key its user-scoped reads filter by (services/tracking/CLAUDE.md §5b). Because
// `init-tracking` resolves the internal `usr_` id through Users' gRPC
// `GetUserById`, which accepts a `usr_` id OR a Cognito sub, the `usr_` id returned
// by `POST /v1/users/register` works directly as `x-user-id` here too — verified
// live, same as for Orders.
//
// ## The env var name is SHARED with a container-internal value — mind the trap
//
// `TRACKING_BASE_URL` also exists in `.env.local.orders`, where `make env-file`
// generates it as the CONTAINER-internal `http://tracking:8000` that Orders uses to
// reach `init-tracking` on the compose network. That value is unreachable from the
// host: taking it here would make every internal Tracking spec fail with a DNS
// error. playwright.config.ts therefore deliberately does NOT load
// `.env.local.orders`, and says so.
//
// Nothing generates a HOST-reachable base URL for any service — `USERS_BASE_URL` and
// `ORDERS_BASE_URL` above are not emitted by the generator either; all three are
// pure fallback defaults, matching the compose port mappings (3000/3001/3002). The
// override exists for a non-default local setup, not because a file supplies it.
export async function trackingClient(): Promise<APIRequestContext> {
  const baseURL = process.env.TRACKING_BASE_URL ?? "http://localhost:3002";
  return request.newContext({ baseURL, extraHTTPHeaders: { "X-E2E-Source": "true" } });
}
