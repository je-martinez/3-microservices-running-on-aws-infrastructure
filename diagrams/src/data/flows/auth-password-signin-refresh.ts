import type { FlowData } from "../../schema";

export const authPasswordSigninRefresh: FlowData = {
  title: "Password sign-in and token refresh",
  subtitle: "Public routes mint tokens; the gateway's JWT authorizer guards the rest",
  actors: [
    { id: "web", label: "Web app", kind: "external" },
    { id: "gateway", label: "API Gateway", kind: "edge", aws: "api-gateway" },
    { id: "users", label: "Users service", kind: "compute", aws: "ecs" },
    { id: "cognito", label: "Cognito", kind: "edge", aws: "cognito" },
    { id: "pretoken", label: "Pre-token trigger", kind: "compute", aws: "lambda" },
  ],
  steps: [
    { from: "web", to: "gateway", label: "Sign in", caption: "Email and password reach a public route; no authorizer runs" },
    { from: "gateway", to: "users", label: "Sign in", caption: "The gateway proxies the request to the Users service" },
    { from: "users", to: "cognito", label: "Admin password auth", caption: "Users checks the credentials with Cognito's admin password flow" },
    { from: "cognito", to: "pretoken", label: "Add claims", caption: "The trigger copies the app user id and forced-change flag into both tokens" },
    { from: "users", to: "web", label: "Three tokens", caption: "Users returns id, access and refresh tokens; the web app stores them" },
    { from: "web", to: "gateway", label: "Bearer call", caption: "A protected call carries the access token to the JWT authorizer" },
    { from: "gateway", to: "web", label: "401 expired", caption: "The authorizer rejects an expired access token before any service sees it" },
    { from: "web", to: "gateway", label: "Refresh", caption: "One shared refresh per burst sends the stored refresh token to a public route" },
    { from: "gateway", to: "users", label: "Refresh", caption: "The gateway proxies the refresh to the Users service" },
    { from: "users", to: "cognito", label: "REFRESH_TOKEN_AUTH", caption: "New id and access tokens; the refresh token is kept and the call retried" },
  ],
};
