import { request } from "@playwright/test";
import { makeUser } from "./chance-factory.js";

// Creates a dedicated, marked E2E user through the gateway (register + login on
// the public auth routes) and returns the token to use as a Bearer. The user is
// cleaned up by the existing e2e-cleanup teardown. Verified live (2026-07-17)
// against the running Floci stack: both the accessToken and the idToken pass
// the JWT authorizer on GET /v1/users/me (200, sub forwarded as x-user-id).
// We prefer accessToken — it's the token meant for authorizing API calls — with
// idToken as a fallback in case a route's authorizer config only accepts it.
export async function getGatewayToken(): Promise<{ token: string; email: string }> {
  const baseURL = process.env.API_GATEWAY_URL;
  if (!baseURL) throw new Error("API_GATEWAY_URL is not set — run `make bootstrap`.");
  const ctx = await request.newContext({ baseURL, extraHTTPHeaders: { "X-E2E-Source": "true" } });
  const user = makeUser();
  const reg = await ctx.post("/v1/users/register", { data: user });
  if (reg.status() !== 201) throw new Error(`register via gateway failed: ${reg.status()} ${await reg.text()}`);
  const login = await ctx.post("/v1/users/login", { data: { email: user.email, password: user.password } });
  if (login.status() !== 200) throw new Error(`login via gateway failed: ${login.status()} ${await login.text()}`);
  const body = await login.json();
  const token = body.accessToken ?? body.idToken;
  if (!token) throw new Error(`login returned no token: ${JSON.stringify(body)}`);
  await ctx.dispose();
  return { token, email: user.email };
}
