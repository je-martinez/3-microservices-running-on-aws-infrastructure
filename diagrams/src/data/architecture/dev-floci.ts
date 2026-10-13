import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: the request-path half of the local map; dev-floci-events.ts draws the rest, and together they
// hold every node and edge in test/fixtures/combined-maps.ts. Only what Terraform attaches to
// module.networking's subnets sits in the subnet (the nginx ECS task, RDS); ElastiCache has no subnet
// group locally. Sources: infra/environments/local/{main.tf,post,scripts/generate_env_files.py},
// infra/modules/**, docker-compose.yml.
export const architectureDevFloci: z.input<typeof AwsDiagramData> = {
  title: "Architecture — local dev (Floci) — request path",
  subtitle: "Services run in Docker Compose, AWS on Floci; nginx routes by path to all three services",
  direction: "RIGHT",
  compact: true,
  groups: [
    { id: "compose-web", kind: "generic", label: "Docker Compose: web" },
    { id: "floci", kind: "local-floci", label: "Floci — local AWS (:4566)" },
    { id: "vpc", kind: "vpc", label: "VPC 10.0.0.0/16", parent: "floci" },
    { id: "subnets", kind: "public-subnet", label: "Subnets a + b", parent: "vpc" },
    { id: "cluster", kind: "ecs-cluster", label: "ECS cluster", parent: "subnets" },
    { id: "compose", kind: "generic", label: "Docker Compose: services" },
  ],
  nodes: [
    { id: "browser", label: "Browser (SPA)", icon: "client" },
    { id: "web", label: "Web app", sublabel: "nginx", icon: "server", group: "compose-web" },
    { id: "apigw", label: "API Gateway", sublabel: "HTTP API", icon: "api-gateway", group: "floci" },
    { id: "nginx", label: "nginx", sublabel: "Fargate · 1 task", icon: "ecs-task", group: "cluster" },
    { id: "orders", label: "Orders", icon: "server", group: "compose" },
    { id: "tracking", label: "Tracking", icon: "server", group: "compose" },
    { id: "users", label: "Users", icon: "server", group: "compose" },
    { id: "cognito", label: "Cognito", sublabel: "user pool", icon: "cognito", group: "floci" },
    { id: "rds", label: "RDS", sublabel: "PostgreSQL + MySQL", icon: "rds", group: "subnets" },
    { id: "redis", label: "ElastiCache", icon: "elasticache", group: "floci" },
    { id: "s3", label: "S3", sublabel: "assets bucket", icon: "s3", group: "floci" },
    { id: "sm", label: "Secrets Manager", sublabel: "read by Terraform only", icon: "secrets-manager", group: "floci" },
  ],
  edges: [
    { id: "browser-web", from: "browser", to: "web", label: "HTTP" },
    { id: "browser-s3", from: "browser", to: "s3", label: "images" },
    { id: "web-apigw", from: "web", to: "apigw", label: "proxy" },
    { id: "apigw-cognito", from: "apigw", to: "cognito", label: "JWT" },
    { id: "apigw-nginx", from: "apigw", to: "nginx", label: "JWT ok" },
    { id: "nginx-compose", from: "nginx", to: "compose", label: "by path" },
    { id: "orders-users", from: "orders", to: "users", label: "gRPC" },
    { id: "tracking-users", from: "tracking", to: "users", label: "gRPC" },
    { id: "users-cognito", from: "users", to: "cognito", label: "admin API" },
    { id: "compose-rds", from: "compose", to: "rds", label: "SQL" },
    { id: "compose-redis", from: "compose", to: "redis", label: "cache" },
  ],
  steps: [],
};
