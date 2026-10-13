import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: drawn as deployed on AWS (pre-prod): the subnet holds the ECS containers and the
// stores Terraform attaches to module.networking's subnets; ElastiCache, messaging, Lambda and
// the APIs stay regional. Sources: infra/modules/{api-gateway,api-gateway-ws,cognito,messaging,
// lambda,networking}, infra/environments/preprod/services.tf, services/*/openapi.yaml.
export const systemContextL2: z.input<typeof AwsDiagramData> = {
  title: "System context — Level 2 (containers)",
  subtitle: "API Gateway reaches the services through nginx (dev) or the ALB (pre-prod)",
  direction: "RIGHT",
  groups: [
    { id: "cloud", kind: "aws-cloud", label: "AWS Cloud (as deployed in pre-prod)" },
    { id: "vpc", kind: "vpc", label: "VPC", parent: "cloud" },
    { id: "subnets", kind: "public-subnet", label: "Subnets a + b", parent: "vpc" },
    { id: "services", kind: "generic", label: "Services", parent: "subnets" },
  ],
  nodes: [
    { id: "customer", label: "Customer", icon: "users" },
    { id: "web", label: "Web app", sublabel: "Angular", icon: "ecs", group: "subnets" },
    { id: "apigw", label: "API Gateway", icon: "api-gateway", group: "cloud" },
    { id: "cognito", label: "Cognito", icon: "cognito", group: "cloud" },
    { id: "ws", label: "WebSocket API", sublabel: "connections table", icon: "api-gateway", group: "cloud" },
    { id: "orders", label: "Orders", sublabel: ".NET", icon: "ecs", group: "services" },
    { id: "users", label: "Users", sublabel: "Node.js", icon: "ecs", group: "services" },
    { id: "tracking", label: "Tracking", sublabel: "Go", icon: "ecs", group: "services" },
    { id: "pg", label: "Users DB", sublabel: "RDS Postgres", icon: "rds", group: "subnets" },
    { id: "mysql", label: "Orders + Tracking DB", sublabel: "RDS MySQL", icon: "rds", group: "subnets" },
    { id: "docdb", label: "Event store", sublabel: "DocumentDB", icon: "documentdb", group: "subnets" },
    { id: "redis", label: "ElastiCache", icon: "elasticache", group: "cloud" },
    { id: "sns", label: "Events topic", icon: "sns", group: "cloud" },
    { id: "notif", label: "Notifications queue", icon: "sqs", group: "cloud" },
    { id: "events", label: "Events queue", icon: "sqs", group: "cloud" },
    { id: "lambda", label: "events-pipeline", icon: "lambda", group: "cloud" },
  ],
  edges: [
    { id: "customer-web", from: "customer", to: "web", label: "HTTP" },
    { id: "customer-ws", from: "customer", to: "ws", label: "socket" },
    { id: "web-apigw", from: "web", to: "apigw", label: "proxy" },
    { id: "apigw-cognito", from: "apigw", to: "cognito", label: "JWT" },
    { id: "apigw-services", from: "apigw", to: "services", label: "routes" },
    { id: "orders-users", from: "orders", to: "users", label: "gRPC" },
    { id: "tracking-users", from: "tracking", to: "users", label: "gRPC" },
    { id: "users-pg", from: "users", to: "pg" },
    { id: "orders-mysql", from: "orders", to: "mysql" },
    { id: "tracking-mysql", from: "tracking", to: "mysql" },
    { id: "services-redis", from: "services", to: "redis", label: "cache" },
    { id: "services-sns", from: "services", to: "sns", label: "publish", async: true },
    { id: "sns-events", from: "sns", to: "events", async: true },
    { id: "sns-notif", from: "sns", to: "notif", async: true },
    { id: "events-lambda", from: "events", to: "lambda", async: true },
    { id: "lambda-docdb", from: "lambda", to: "docdb" },
    { id: "notif-users", from: "notif", to: "users", label: "notify", async: true },
    { id: "users-ws", from: "users", to: "ws", label: "push" },
  ],
  steps: [],
};
