import { request } from "@playwright/test";
import { makeUser } from "./chance-factory.js";

// Creates a marked E2E user through the gateway (register + login on the public auth
// routes) and returns a Bearer token; the e2e-cleanup teardown removes the user. Both
// accessToken and idToken pass the JWT authorizer, so accessToken is preferred — it is
// the token meant for authorizing API calls — with idToken as a fallback for a route
// whose authorizer accepts only that.
export async function getGatewayToken(): Promise<{ token: string; email: string }> {
  const rawBaseURL = process.env.API_GATEWAY_URL;
  if (!rawBaseURL) throw new Error("API_GATEWAY_URL is not set — run `make bootstrap`.");
  // See gateway-client.ts for why: trailing-slash baseURL + relative request
  // paths, so WHATWG URL joining appends onto the gateway's path instead of
  // replacing it with a leading slash.
  const baseURL = rawBaseURL.endsWith("/") ? rawBaseURL : `${rawBaseURL}/`;
  const ctx = await request.newContext({ baseURL, extraHTTPHeaders: { "X-E2E-Source": "true" } });
  const user = makeUser();
  const reg = await ctx.post("v1/users/register", { data: user });
  if (reg.status() !== 201) throw new Error(`register via gateway failed: ${reg.status()} ${await reg.text()}`);
  const login = await ctx.post("v1/users/login", { data: { email: user.email, password: user.password } });
  if (login.status() !== 200) throw new Error(`login via gateway failed: ${login.status()} ${await login.text()}`);
  const body = await login.json();
  const token = body.accessToken ?? body.idToken;
  if (!token) throw new Error(`login returned no token: ${JSON.stringify(body)}`);
  await ctx.dispose();
  return { token, email: user.email };
}
