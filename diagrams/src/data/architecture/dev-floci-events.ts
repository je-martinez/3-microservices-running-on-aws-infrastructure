import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: the events-and-observability half of the local map; dev-floci.ts draws the request path, and
// together they hold every node and edge in test/fixtures/combined-maps.ts. The Compose services, the
// browser, the web app and nginx are anchors repeated from the request view. DocumentDB is here because
// only the events-pipeline Lambda writes it. Sources: infra/environments/local/main.tf, infra/modules/**,
// docker-compose.yml, observability/otel-collector-config.yaml, services/users/src/shared/realtime/.
export const architectureDevFlociEvents: z.input<typeof AwsDiagramData> = {
  title: "Architecture — local dev (Floci) — events & observability",
  subtitle: "Domain events fan out through SNS and SQS; telemetry reaches OpenObserve through the OTel collector",
  direction: "RIGHT",
  compact: true,
  groups: [
    { id: "compose-web", kind: "generic", label: "Docker Compose: web" },
    { id: "compose", kind: "generic", label: "Docker Compose: services" },
    { id: "compose-obs", kind: "generic", label: "Docker Compose: observability" },
    { id: "floci", kind: "local-floci", label: "Floci — local AWS (:4566)" },
    { id: "vpc", kind: "vpc", label: "VPC 10.0.0.0/16", parent: "floci" },
    { id: "subnets", kind: "public-subnet", label: "Subnets a + b", parent: "vpc" },
    { id: "cluster", kind: "ecs-cluster", label: "ECS cluster", parent: "subnets" },
    { id: "realtime", kind: "generic", label: "Realtime", parent: "floci" },
  ],
  nodes: [
    { id: "browser", label: "Browser (SPA)", icon: "client" },
    { id: "web", label: "Web app", sublabel: "nginx", icon: "server", group: "compose-web" },
    { id: "orders", label: "Orders", icon: "server", group: "compose" },
    { id: "tracking", label: "Tracking", icon: "server", group: "compose" },
    { id: "users", label: "Users", icon: "server", group: "compose" },
    { id: "cognito", label: "Cognito", sublabel: "user pool", icon: "cognito", group: "floci" },
    { id: "cognito-fns", label: "Cognito triggers", sublabel: "pre-token · OTP challenge", icon: "lambda", group: "floci" },
    { id: "sns", label: "Events topic", icon: "sns", group: "floci" },
    { id: "eb", label: "EventBridge", sublabel: "metrics-tick rule", icon: "eventbridge", group: "floci" },
    { id: "sqs", label: "SQS", sublabel: "events + notifications", icon: "sqs", group: "floci" },
    { id: "lambda", label: "events-pipeline", icon: "lambda", group: "floci" },
    { id: "ses", label: "SES", sublabel: "Mailpit", icon: "ses", group: "floci" },
    { id: "cw", label: "CloudWatch", sublabel: "Logs + Metrics (3MRAI)", icon: "cloudwatch", group: "floci" },
    { id: "dlq", label: "DLQ", sublabel: "shared by both queues", icon: "sqs", group: "floci" },
    { id: "docdb", label: "Event store", sublabel: "DocumentDB", icon: "documentdb", group: "subnets" },
    { id: "nginx", label: "nginx", sublabel: "Fargate · 1 task", icon: "ecs-task", group: "cluster" },
    { id: "ws", label: "WebSocket API", icon: "api-gateway", group: "realtime" },
    { id: "dynamodb", label: "DynamoDB", sublabel: "ws-connections", icon: "dynamodb", group: "realtime" },
    { id: "ws-fns", label: "WS Lambdas", sublabel: "authorizer + 3 routes", icon: "lambda", group: "floci" },
    { id: "otel", label: "OTel collector", sublabel: "→ OpenObserve :5080", icon: "server", group: "compose-obs" },
  ],
  edges: [
    { id: "compose-cw", from: "compose", to: "cw", label: "metrics" },
    { id: "ws-fns", from: "ws", to: "ws-fns", label: "routes" },
    { id: "users-realtime", from: "users", to: "realtime", label: "push" },
    { id: "sqs-users", from: "sqs", to: "users", label: "notify", async: true },
    { id: "browser-ws", from: "browser", to: "ws", label: "socket" },
    { id: "ws-fns-otel", from: "ws-fns", to: "otel", label: "traces" },
    { id: "compose-otel", from: "compose", to: "otel", label: "traces + logs" },
    // WHY: Terraform gives the Cognito triggers no log group and no logs permission (modules/cognito);
    // their logs land only because Floci auto-creates log groups.
    { id: "fns-cw", from: "cognito-fns", to: "cw" },
    { id: "lambda-docdb", from: "lambda", to: "docdb" },
    // WHY: Users and the pipeline query the connections table and post to @connections; neither
    // invokes the WS Lambdas (services/users/src/shared/realtime/).
    { id: "lambda-realtime", from: "lambda", to: "realtime", label: "fan-out" },
    { id: "lambda-otel", from: "lambda", to: "otel", label: "traces" },
    { id: "ws-fns-cw", from: "ws-fns", to: "cw" },
    { id: "lambda-ses", from: "lambda", to: "ses" },
    { id: "sqs-dlq", from: "sqs", to: "dlq", label: "redrive", async: true },
    { id: "lambda-cw", from: "lambda", to: "cw", label: "logs + metrics" },
    { id: "ws-fns-dynamodb", from: "ws-fns", to: "dynamodb" },
    { id: "cw-otel", from: "cw", to: "otel", label: "logs + GetMetricData" },
    { id: "fns-sqs", from: "cognito-fns", to: "sqs", label: "OTP event", async: true },
    { id: "sns-sqs", from: "sns", to: "sqs", async: true },
    { id: "eb-lambda", from: "eb", to: "lambda", label: "rate(1 min)", async: true },
    { id: "cognito-fns", from: "cognito", to: "cognito-fns", label: "triggers" },
    { id: "sqs-lambda", from: "sqs", to: "lambda", label: "events", async: true },
    { id: "nginx-cw", from: "nginx", to: "cw" },
    { id: "compose-sns", from: "compose", to: "sns", label: "publish", async: true },
    { id: "web-otel", from: "web", to: "otel", label: "RUM + logs" },
  ],
  steps: [],
};
