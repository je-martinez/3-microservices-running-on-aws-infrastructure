import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: the events-and-observability half of the container view (pre-prod); l2.ts draws the request
// path, and together they hold every node and edge in test/fixtures/combined-maps.ts. The customer and
// the service containers are anchors repeated from the request view. DocumentDB is here because only the
// events-pipeline Lambda writes it. Sources: infra/modules/**, infra/environments/preprod/{main,services}.tf,
// observability/otel-collector-config.yaml, services/users/src/shared/realtime/.
export const systemContextL2Events: z.input<typeof AwsDiagramData> = {
  title: "System context — Level 2 (containers) — events & observability",
  subtitle: "Pre-prod: domain events fan out through SNS and SQS; telemetry reaches OpenObserve via the collector",
  direction: "RIGHT",
  compact: true,
  groups: [
    { id: "cloud", kind: "aws-cloud", label: "AWS Cloud (as deployed in pre-prod)" },
    { id: "vpc", kind: "vpc", label: "VPC 10.1.0.0/16", parent: "cloud" },
    { id: "cluster", kind: "ecs-cluster", label: "ECS cluster", parent: "vpc" },
    { id: "services", kind: "generic", label: "Services", parent: "cluster" },
    { id: "fns", kind: "generic", label: "Lambda functions", parent: "cloud" },
    { id: "realtime", kind: "generic", label: "Realtime", parent: "cloud" },
  ],
  nodes: [
    { id: "customer", label: "Customer", icon: "users" },
    { id: "cognito", label: "Cognito", sublabel: "user pool", icon: "cognito", group: "cloud" },
    { id: "cognito-fns", label: "Cognito triggers", sublabel: "pre-token + OTP", icon: "lambda", group: "fns" },
    { id: "eb", label: "EventBridge", sublabel: "metrics tick", icon: "eventbridge", group: "cloud" },
    { id: "sns", label: "Events topic", icon: "sns", group: "cloud" },
    { id: "sqs", label: "SQS", sublabel: "events + notif", icon: "sqs", group: "cloud" },
    { id: "dlq", label: "DLQ", sublabel: "both queues", icon: "sqs", group: "cloud" },
    { id: "lambda", label: "events-pipeline", icon: "lambda", group: "fns" },
    { id: "ses", label: "SES", icon: "ses", group: "cloud" },
    { id: "cw", label: "CloudWatch", sublabel: "Logs + Metrics", icon: "cloudwatch", group: "cloud" },
    { id: "ws", label: "WebSocket API", icon: "api-gateway", group: "realtime" },
    { id: "ws-fns", label: "WS Lambdas", sublabel: "4 functions", icon: "lambda", group: "fns" },
    { id: "dynamodb", label: "DynamoDB", sublabel: "ws-connections", icon: "dynamodb", group: "realtime" },
    { id: "docdb", label: "Event store", sublabel: "DocumentDB", icon: "documentdb", group: "vpc" },
    { id: "web", label: "Web app", sublabel: "Angular", icon: "ecs-task", group: "cluster" },
    { id: "orders", label: "Orders", sublabel: ".NET", icon: "ecs-task", group: "services" },
    { id: "tracking", label: "Tracking", sublabel: "Go", icon: "ecs-task", group: "services" },
    { id: "users", label: "Users", sublabel: "Node.js", icon: "ecs-task", group: "services" },
    { id: "mailpit", label: "Mailpit", sublabel: "SMTP sink", icon: "ecs-task", group: "cluster" },
    { id: "otel", label: "otel-collector", sublabel: "telemetry", icon: "ecs-task", group: "cluster" },
    { id: "o2", label: "OpenObserve", sublabel: "logs + traces", icon: "ecs-task", group: "cluster" },
  ],
  edges: [
    { id: "users-realtime", from: "users", to: "realtime", label: "push" },
    { id: "services-otel", from: "services", to: "otel", label: "traces" },
    { id: "sqs-lambda", from: "sqs", to: "lambda", label: "events", async: true },
    { id: "lambda-otel", from: "lambda", to: "otel", label: "traces" },
    { id: "sqs-users", from: "sqs", to: "users", label: "notify", async: true },
    { id: "cw-otel", from: "cw", to: "otel", label: "logs + GetMetricData" },
    { id: "lambda-docdb", from: "lambda", to: "docdb" },
    { id: "cognito-fns", from: "cognito", to: "cognito-fns", label: "triggers" },
    { id: "sns-sqs", from: "sns", to: "sqs", async: true },
    { id: "eb-lambda", from: "eb", to: "lambda", label: "rate(1 min)", async: true },
    { id: "ws-fns-dynamodb", from: "ws-fns", to: "dynamodb", label: "connections" },
    { id: "services-sns", from: "services", to: "sns", async: true },
    { id: "sqs-dlq", from: "sqs", to: "dlq", label: "redrive", async: true },
    // WHY: every container logs through the awslogs driver; the services also PutMetricData.
    { id: "cluster-cw", from: "cluster", to: "cw", label: "logs + metrics" },
    // WHY: Terraform gives the Cognito triggers no log group and no logs permission (modules/cognito);
    // their logs land only because Floci auto-creates log groups.
    { id: "fns-cw", from: "fns", to: "cw", label: "logs + pipeline metrics" },
    { id: "ws-fns-otel", from: "ws-fns", to: "otel", label: "traces" },
    { id: "ses-mailpit", from: "ses", to: "mailpit", label: "SMTP" },
    { id: "fns-sqs", from: "cognito-fns", to: "sqs", label: "OTP event", async: true },
    { id: "customer-ws", from: "customer", to: "ws", label: "socket" },
    { id: "otel-o2", from: "otel", to: "o2" },
    // WHY: realtime is exactly the WebSocket API and the connections table: Users and the pipeline query
    // the table and post to @connections; neither invokes the WS Lambdas.
    { id: "lambda-realtime", from: "lambda", to: "realtime", label: "fan-out" },
    { id: "lambda-ses", from: "lambda", to: "ses" },
    { id: "web-otel", from: "web", to: "otel", label: "RUM :4319" },
    { id: "ws-fns", from: "ws", to: "ws-fns", label: "routes" },
  ],
  steps: [],
};
