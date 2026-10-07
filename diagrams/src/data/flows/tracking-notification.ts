import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: local dev. Tracking and Users run in Docker Compose; the WS API, the connections table,
// SNS, both queues and the pipeline Lambda run on Floci outside the VPC; both databases sit in
// module.networking's subnets (Tracking shares the RDS MySQL cluster). Sources:
// infra/modules/{messaging,dynamodb,api-gateway-ws}, infra/environments/local/main.tf. The push
// travels back over the socket the browser opened, so steps 1 and 10 share that edge.
export const trackingNotification: z.input<typeof AwsDiagramData> = {
  title: "Delivery status change to an in-app toast",
  subtitle: "Local dev on Floci: Tracking commits through an outbox; Users stores the notification and pushes it",
  direction: "RIGHT",
  groups: [
    { id: "compose", kind: "generic", label: "Docker Compose" },
    { id: "floci", kind: "local-floci", label: "Floci (:4566)" },
    { id: "vpc", kind: "vpc", label: "VPC 10.0.0.0/16", parent: "floci" },
    { id: "subnets", kind: "public-subnet", label: "Subnets a + b", parent: "vpc" },
  ],
  nodes: [
    { id: "web", label: "Web app", icon: "client" },
    { id: "carrier", label: "Carrier", icon: "internet" },
    { id: "tracking", label: "Tracking service", icon: "server", group: "compose" },
    { id: "users", label: "Users service", icon: "server", group: "compose" },
    { id: "trackdb", label: "Tracking DB", sublabel: "RDS MySQL", icon: "rds", group: "subnets" },
    { id: "usersdb", label: "Users DB", sublabel: "RDS PostgreSQL", icon: "rds", group: "subnets" },
    { id: "sns", label: "Events topic", icon: "sns", group: "floci" },
    { id: "eventsq", label: "Events queue", icon: "sqs", group: "floci" },
    { id: "notifq", label: "Notifications queue", icon: "sqs", group: "floci" },
    { id: "pipeline", label: "Events pipeline", icon: "lambda", group: "floci" },
    { id: "ws", label: "WS API", icon: "api-gateway", group: "floci" },
    { id: "conns", label: "Sockets", sublabel: "DynamoDB", icon: "dynamodb", group: "floci" },
  ],
  edges: [
    { id: "web-ws", from: "web", to: "ws", label: "socket" },
    { id: "ws-conns", from: "ws", to: "conns", label: "save" },
    { id: "carrier-tracking", from: "carrier", to: "tracking", label: "webhook", async: true },
    { id: "tracking-trackdb", from: "tracking", to: "trackdb", label: "commit + outbox" },
    { id: "tracking-sns", from: "tracking", to: "sns", label: "STATUS_CHANGED", async: true },
    { id: "sns-eventsq", from: "sns", to: "eventsq", async: true },
    { id: "eventsq-pipeline", from: "eventsq", to: "pipeline", label: "status email", async: true },
    { id: "sns-notifq", from: "sns", to: "notifq", label: "filtered", async: true },
    { id: "notifq-users", from: "notifq", to: "users", async: true },
    { id: "users-usersdb", from: "users", to: "usersdb", label: "notification row" },
    { id: "users-conns", from: "users", to: "conns", label: "query" },
    { id: "users-ws", from: "users", to: "ws", label: "PostToConnection" },
  ],
  steps: [
    { edges: ["web-ws"], caption: "The $connect authorizer Lambda validates the user's JWT before the socket opens" },
    { edges: ["ws-conns"], caption: "The connect Lambda stores the connection id under the cognito_sub, 2-hour TTL" },
    { edges: ["carrier-tracking"], caption: "The carrier webhook reaches Tracking; the transition is checked first" },
    { edges: ["tracking-trackdb"], caption: "Status, history row and outbox message are written in one MySQL transaction" },
    { edges: ["tracking-sns", "sns-eventsq", "eventsq-pipeline"], caption: "The outbox poller publishes TRACKING_STATUS_CHANGED to SNS; the pipeline emails it" },
    { edges: ["sns-notifq", "notifq-users"], caption: "The same SNS message reaches Users through its filtered notifications queue" },
    { edges: ["users-usersdb"], caption: "Users writes the ORDER_STATUS notification row before attempting any push" },
    { edges: ["users-conns"], caption: "Users reads every open connection for the owner's cognito_sub" },
    { edges: ["users-ws"], caption: "Each socket gets the notification and unread count; a 410 Gone row is deleted" },
    { edges: ["web-ws"], caption: "The web app shows a toast and updates the unread badge with no extra request" },
  ],
};
