import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: the request-path half of the pre-prod map; preprod-events.ts draws the rest, and together they
// hold every node and edge in test/fixtures/combined-maps.ts. Each ECS service stays its own task node;
// only what Terraform attaches to module.networking's subnets sits in the VPC (ALB, the ECS services of
// aws_ecs_cluster.this, RDS); ElastiCache has no subnet group. Sources:
// infra/environments/preprod/{main,services}.tf, infra/modules/**, docker-compose.preprod.yml.
export const architecturePreprod: z.input<typeof AwsDiagramData> = {
  title: "Architecture — pre-prod (ECS on Floci) — request path",
  subtitle: "One ECS cluster across two AZs: ECS places each Fargate task in either subnet; one ALB listener per service",
  direction: "RIGHT",
  compact: true,
  groups: [
    { id: "cloud", kind: "aws-cloud", label: "AWS Cloud us-east-1 (pre-prod Floci)" },
    {
      id: "vpc", kind: "vpc", label: "VPC 10.1.0.0/16", parent: "cloud",
      lanes: [
        { label: "us-east-1a", sublabel: "Public subnet 10.1.1.0/24" },
        { label: "us-east-1b", sublabel: "Public subnet 10.1.2.0/24" },
      ],
    },
    { id: "cluster", kind: "ecs-cluster", label: "ECS cluster · 1 task per service", parent: "vpc" },
    { id: "backend", kind: "generic", label: "Backend services · gRPC to users", parent: "cluster" },
  ],
  nodes: [
    { id: "browser", label: "Browser (SPA)", icon: "client" },
    { id: "apigw", label: "API Gateway", sublabel: "HTTP API", icon: "api-gateway", group: "cloud" },
    { id: "alb", label: "ALB", sublabel: "internal", icon: "alb", group: "vpc" },
    { id: "web", label: "web", sublabel: "Fargate", icon: "ecs-task", group: "cluster" },
    { id: "orders", label: "orders", sublabel: "Fargate", icon: "ecs-task", group: "backend" },
    { id: "tracking", label: "tracking", sublabel: "Fargate", icon: "ecs-task", group: "backend" },
    { id: "users", label: "users", sublabel: "Fargate", icon: "ecs-task", group: "backend" },
    { id: "cognito", label: "Cognito", sublabel: "user pool", icon: "cognito", group: "cloud" },
    { id: "rds", label: "RDS", sublabel: "Postgres + MySQL", icon: "rds", group: "vpc" },
    { id: "redis", label: "ElastiCache", icon: "elasticache", group: "cloud" },
    { id: "s3", label: "S3", sublabel: "assets bucket", icon: "s3", group: "cloud" },
    { id: "ecr", label: "ECR", sublabel: "7 images", icon: "ecr", group: "cloud" },
    { id: "config", label: "SSM + Secrets Manager", sublabel: "params · secrets · RDS creds", icon: "ssm", group: "cloud" },
  ],
  edges: [
    { id: "browser-alb", from: "browser", to: "alb", label: "SPA :9090" },
    { id: "browser-apigw", from: "browser", to: "apigw", label: "/v1 via web" },
    { id: "browser-s3", from: "browser", to: "s3", label: "images" },
    { id: "apigw-cognito", from: "apigw", to: "cognito", label: "JWT authorizer" },
    { id: "apigw-alb", from: "apigw", to: "alb", label: "routes" },
    // WHY: every one of the seven ECS services has its own listener and target group (modules/ecs-service).
    { id: "alb-cluster", from: "alb", to: "cluster", label: "listener per service" },
    { id: "orders-users", from: "orders", to: "users" },
    { id: "tracking-users", from: "tracking", to: "users" },
    { id: "users-cognito", from: "users", to: "cognito", label: "admin API" },
    { id: "backend-rds", from: "backend", to: "rds", label: "SQL" },
    { id: "backend-redis", from: "backend", to: "redis" },
    { id: "ecr-cluster", from: "ecr", to: "cluster", label: "images" },
    { id: "config-cluster", from: "config", to: "cluster", label: "task config" },
  ],
  steps: [],
};
