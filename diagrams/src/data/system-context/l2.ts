import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: the request-path half of the container view, drawn as deployed on AWS (pre-prod);
// l2-events.ts draws the rest, and together they hold every node and edge in
// test/fixtures/combined-maps.ts. The VPC holds the ALB, the ECS cluster's containers and the stores
// Terraform attaches to module.networking's subnets; ElastiCache and the APIs stay regional. SSM and
// Secrets Manager share a node because both only feed task definitions here. Sources:
// infra/modules/**, infra/environments/preprod/{main,services}.tf, services/*/openapi.yaml.
export const systemContextL2: z.input<typeof AwsDiagramData> = {
  title: "System context — Level 2 (containers) — request path",
  subtitle: "Pre-prod: ECS places each container in either AZ; API Gateway reaches them through the ALB (nginx in dev)",
  direction: "RIGHT",
  compact: true,
  groups: [
    { id: "cloud", kind: "aws-cloud", label: "AWS Cloud (as deployed in pre-prod)" },
    {
      id: "vpc", kind: "vpc", label: "VPC 10.1.0.0/16", parent: "cloud",
      lanes: [
        { label: "us-east-1a", sublabel: "Public subnet 10.1.1.0/24" },
        { label: "us-east-1b", sublabel: "Public subnet 10.1.2.0/24" },
      ],
    },
    { id: "cluster", kind: "ecs-cluster", label: "ECS cluster", parent: "vpc" },
    { id: "services", kind: "generic", label: "Services", parent: "cluster" },
  ],
  nodes: [
    { id: "customer", label: "Customer", icon: "users" },
    { id: "apigw", label: "API Gateway", sublabel: "HTTP API", icon: "api-gateway", group: "cloud" },
    { id: "alb", label: "ALB", sublabel: "internal", icon: "alb", group: "vpc" },
    { id: "web", label: "Web app", sublabel: "Angular", icon: "ecs-task", group: "cluster" },
    { id: "orders", label: "Orders", sublabel: ".NET", icon: "ecs-task", group: "services" },
    { id: "tracking", label: "Tracking", sublabel: "Go", icon: "ecs-task", group: "services" },
    { id: "users", label: "Users", sublabel: "Node.js", icon: "ecs-task", group: "services" },
    { id: "cognito", label: "Cognito", sublabel: "user pool", icon: "cognito", group: "cloud" },
    { id: "pg", label: "Users DB", sublabel: "RDS Postgres", icon: "rds", group: "vpc" },
    { id: "mysql", label: "Orders + Tracking DB", sublabel: "RDS MySQL", icon: "rds", group: "vpc" },
    { id: "redis", label: "ElastiCache", icon: "elasticache", group: "cloud" },
    { id: "s3", label: "S3", sublabel: "assets bucket", icon: "s3", group: "cloud" },
    { id: "ecr", label: "ECR", sublabel: "7 images", icon: "ecr", group: "cloud" },
    { id: "config", label: "SSM + Secrets Manager", sublabel: "task config", icon: "ssm", group: "cloud" },
  ],
  edges: [
    { id: "customer-alb", from: "customer", to: "alb", label: "SPA" },
    { id: "customer-apigw", from: "customer", to: "apigw", label: "/v1 via web" },
    { id: "customer-s3", from: "customer", to: "s3", label: "images" },
    { id: "apigw-cognito", from: "apigw", to: "cognito", label: "JWT authorizer" },
    { id: "apigw-alb", from: "apigw", to: "alb", label: "routes" },
    { id: "alb-cluster", from: "alb", to: "cluster", label: "listener per service" },
    { id: "orders-users", from: "orders", to: "users", label: "gRPC" },
    { id: "tracking-users", from: "tracking", to: "users", label: "gRPC" },
    { id: "users-cognito", from: "users", to: "cognito", label: "admin API" },
    { id: "users-pg", from: "users", to: "pg" },
    { id: "orders-mysql", from: "orders", to: "mysql" },
    { id: "tracking-mysql", from: "tracking", to: "mysql" },
    { id: "services-redis", from: "services", to: "redis" },
    { id: "ecr-cluster", from: "ecr", to: "cluster", label: "images" },
    { id: "config-cluster", from: "config", to: "cluster", label: "task config" },
  ],
  steps: [],
};
