import type { FlowData } from "../../schema";

export const trackingNotification: FlowData = {
  title: "Delivery status change to an in-app toast",
  subtitle: "Tracking commits through an outbox; Users stores the notification and pushes it",
  actors: [
    { id: "web", label: "Web app", kind: "external" },
    { id: "ws", label: "WS API", kind: "edge", aws: "api-gateway" },
    { id: "conns", label: "Sockets", kind: "data", aws: "dynamodb" },
    { id: "users", label: "Users service", kind: "compute", aws: "ecs" },
    { id: "pipeline", label: "Events pipeline", kind: "compute", aws: "lambda" },
    { id: "tracking", label: "Tracking service", kind: "compute", aws: "ecs" },
    { id: "carrier", label: "Carrier", kind: "external" },
  ],
  steps: [
    { from: "web", to: "ws", label: "Open socket", caption: "The $connect authorizer Lambda validates the user's JWT before the socket opens" },
    { from: "ws", to: "conns", label: "Save connection", caption: "The connect Lambda stores the connection id under the cognito_sub, 2-hour TTL" },
    { from: "carrier", to: "tracking", label: "Status update", caption: "The carrier webhook reaches Tracking; the transition is checked first" },
    { from: "tracking", to: "tracking", label: "Commit + outbox", caption: "Status, history row and outbox message are written in one MySQL transaction" },
    { from: "tracking", to: "pipeline", label: "Status email", caption: "The outbox poller publishes TRACKING_STATUS_CHANGED to SNS; the pipeline emails it", async: true },
    { from: "tracking", to: "users", label: "TRACKING_STATUS_CHANGED", caption: "The same SNS message reaches Users through its filtered notifications queue", async: true },
    { from: "users", to: "users", label: "Insert notification", caption: "Users writes the ORDER_STATUS notification row before attempting any push" },
    { from: "users", to: "conns", label: "Query connections", caption: "Users reads every open connection for the owner's cognito_sub" },
    { from: "users", to: "ws", label: "PostToConnection", caption: "Each socket gets the notification and unread count; a 410 Gone row is deleted" },
    { from: "ws", to: "web", label: "NOTIFICATION_CREATED", caption: "The web app shows a toast and updates the unread badge with no extra request", async: true },
  ],
};
