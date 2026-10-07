import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// WHY: local dev — the WS API, its four Lambdas (no vpc_config) and the DynamoDB connections
// table are regional on Floci (infra/modules/api-gateway-ws); nothing here sits in the VPC.
export const websocketLifecycle: z.input<typeof AwsDiagramData> = {
  title: "WebSocket connection lifecycle",
  subtitle: "Local dev: Lambdas behind the WS API; the connections table is keyed by cognito_sub",
  direction: "RIGHT",
  groups: [
    { id: "floci", kind: "local-floci", label: "Floci (:4566)" },
  ],
  nodes: [
    { id: "web", label: "Web app", sublabel: "browser", icon: "client" },
    { id: "pipeline", label: "Events pipeline", icon: "lambda", group: "floci" },
    { id: "ws", label: "WS API", icon: "api-gateway", group: "floci" },
    { id: "auth", label: "Auth Lambda", sublabel: "$connect authorizer", icon: "lambda", group: "floci" },
    { id: "connect", label: "Connect fn", icon: "lambda", group: "floci" },
    { id: "disconnect", label: "Close fn", icon: "lambda", group: "floci" },
    { id: "conns", label: "Sockets", sublabel: "DynamoDB connections", icon: "dynamodb", group: "floci" },
  ],
  edges: [
    { id: "web-ws", from: "web", to: "ws", label: "socket" },
    { id: "ws-auth", from: "ws", to: "auth", label: "authorize" },
    { id: "auth-ws", from: "auth", to: "ws", label: "allow + sub" },
    { id: "ws-connect", from: "ws", to: "connect", label: "$connect" },
    { id: "connect-conns", from: "connect", to: "conns", label: "put" },
    { id: "pipeline-ws", from: "pipeline", to: "ws", label: "PostToConnection", async: true },
    { id: "pipeline-conns", from: "pipeline", to: "conns", label: "prune on 410" },
    { id: "ws-disconnect", from: "ws", to: "disconnect", label: "$disconnect" },
    { id: "disconnect-conns", from: "disconnect", to: "conns", label: "delete" },
  ],
  steps: [
    { edges: ["web-ws"], caption: "A browser socket cannot set headers, so the Cognito token rides in the query string" },
    { edges: ["ws-auth"], caption: "The $connect REQUEST authorizer verifies the JWT; a missing or bad token is denied" },
    { edges: ["auth-ws"], caption: "An Allow policy returns the cognito_sub as authorizer context" },
    { edges: ["ws-connect"], caption: "The connect Lambda trusts only the authorizer context, never the query string" },
    { edges: ["connect-conns"], caption: "The connection id is stored with its cognito_sub and a 2-hour TTL, the API's cap" },
    { edges: ["web-ws"], caption: "The $default Lambda answers 400: the channel is server-to-client only" },
    { edges: ["pipeline-ws"], caption: "The pipeline pushes to every open socket of the user's cognito_sub" },
    { edges: ["pipeline-conns"], caption: "A 410 Gone deletes the stale row; that, not the TTL, is the real cleanup" },
    { edges: ["ws-disconnect"], caption: "When the socket closes, the $disconnect Lambda runs" },
    { edges: ["disconnect-conns"], caption: "Its row is deleted; a failed delete is only logged, as the 410 prune covers it" },
  ],
};
