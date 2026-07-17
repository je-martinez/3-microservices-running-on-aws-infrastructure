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
