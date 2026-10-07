import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: drawn as local dev. Users runs in Docker Compose; API Gateway, Cognito and the
// pre-token Lambda run on Floci outside the VPC. A response reuses its request's edge. Sources:
// infra/modules/{cognito,api-gateway}, apps/web/src/app/core/auth/refresh-interceptor.ts.
export const authPasswordSigninRefresh: z.input<typeof AwsDiagramData> = {
  title: "Password sign-in and token refresh",
  subtitle: "Public routes mint tokens; the gateway's JWT authorizer guards the rest (local dev)",
  direction: "RIGHT",
  groups: [
    { id: "compose", kind: "generic", label: "Docker Compose" },
    { id: "floci", kind: "local-floci", label: "Floci (:4566)" },
  ],
  nodes: [
    { id: "web", label: "Web app", sublabel: "browser", icon: "client" },
    { id: "gateway", label: "API Gateway", sublabel: "JWT authorizer", icon: "api-gateway", group: "floci" },
    { id: "users", label: "Users service", icon: "server", group: "compose" },
    { id: "cognito", label: "Cognito", icon: "cognito", group: "floci" },
    { id: "pretoken", label: "Pre-token trigger", icon: "lambda", group: "floci" },
  ],
  edges: [
    { id: "web-gateway", from: "web", to: "gateway", label: "sign in / refresh / call" },
    { id: "gateway-users", from: "gateway", to: "users", label: "proxy" },
    { id: "users-cognito", from: "users", to: "cognito", label: "password / refresh" },
    { id: "cognito-pretoken", from: "cognito", to: "pretoken", label: "add claims" },
  ],
  steps: [
    { edges: ["web-gateway"], caption: "Email and password reach a public route; no authorizer runs" },
    { edges: ["gateway-users"], caption: "The gateway proxies the request to the Users service" },
    { edges: ["users-cognito"], caption: "Users checks the credentials with Cognito's admin password flow" },
    { edges: ["cognito-pretoken"], caption: "The trigger copies the app user id and forced-change flag into both tokens" },
    { edges: ["gateway-users", "web-gateway"], caption: "Users returns id, access and refresh tokens; the web app stores them" },
    { edges: ["web-gateway"], caption: "A protected call carries the access token to the JWT authorizer" },
    { edges: ["web-gateway"], caption: "The authorizer rejects an expired access token before any service sees it" },
    { edges: ["web-gateway"], caption: "One shared refresh per burst sends the stored refresh token to a public route" },
    { edges: ["gateway-users"], caption: "The gateway proxies the refresh to the Users service" },
    { edges: ["users-cognito"], caption: "New id and access tokens; the refresh token is kept and the call retried" },
  ],
};
