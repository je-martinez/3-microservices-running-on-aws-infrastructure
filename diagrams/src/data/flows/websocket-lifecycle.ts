import type { FlowData } from "../../schema";

export const websocketLifecycle: FlowData = {
  title: "WebSocket connection lifecycle",
  subtitle: "Four Lambdas behind the WS API; the connections table is keyed by cognito_sub",
  actors: [
    { id: "web", label: "Web app", kind: "external" },
    { id: "ws", label: "WS API", kind: "edge", aws: "api-gateway" },
    { id: "auth", label: "Auth Lambda", kind: "compute", aws: "lambda" },
    { id: "connect", label: "Connect fn", kind: "compute", aws: "lambda" },
    { id: "disconnect", label: "Close fn", kind: "compute", aws: "lambda" },
    { id: "conns", label: "Sockets", kind: "data", aws: "dynamodb" },
    { id: "pipeline", label: "Events pipeline", kind: "compute", aws: "lambda" },
  ],
  steps: [
    { from: "web", to: "ws", label: "Handshake", caption: "A browser socket cannot set headers, so the Cognito token rides in the query string" },
    { from: "ws", to: "auth", label: "Authorize", caption: "The $connect REQUEST authorizer verifies the JWT; a missing or bad token is denied" },
    { from: "auth", to: "ws", label: "Allow + sub", caption: "An Allow policy returns the cognito_sub as authorizer context" },
    { from: "ws", to: "connect", label: "$connect", caption: "The connect Lambda trusts only the authorizer context, never the query string" },
    { from: "connect", to: "conns", label: "Put connection", caption: "The connection id is stored with its cognito_sub and a 2-hour TTL, the API's cap" },
    { from: "web", to: "ws", label: "Inbound frame", caption: "The $default Lambda answers 400: the channel is server-to-client only" },
    { from: "pipeline", to: "ws", label: "PostToConnection", caption: "The pipeline pushes to every open socket of the user's cognito_sub", async: true },
    { from: "pipeline", to: "conns", label: "Prune on 410", caption: "A 410 Gone deletes the stale row; that, not the TTL, is the real cleanup" },
    { from: "ws", to: "disconnect", label: "$disconnect", caption: "When the socket closes, the $disconnect Lambda runs" },
    { from: "disconnect", to: "conns", label: "Delete row", caption: "Its row is deleted; a failed delete is only logged, as the 410 prune covers it" },
  ],
};
