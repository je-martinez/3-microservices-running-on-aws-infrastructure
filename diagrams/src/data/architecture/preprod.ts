import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: every runtime AWS resource is one node per service, its instances in the sublabel; each
// ECS service stays its own task node. Only what Terraform attaches to module.networking's subnets
// sits in the VPC (ALB, the ECS services of aws_ecs_cluster.this, RDS, DocDB); ElastiCache has no
// subnet group, Lambda no vpc_config. Sources: infra/environments/preprod/{main,services}.tf,
// infra/modules/**, docker-compose.preprod.yml, observability/otel-collector-config.yaml.
export const architecturePreprod: z.input<typeof AwsDiagramData> = {
  title: "Architecture — pre-prod (ECS on Floci)",
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
    { id: "realtime", kind: "generic", label: "Realtime", parent: "cloud" },
    { id: "fns", kind: "generic", label: "Lambda functions", parent: "cloud" },
  ],
  nodes: [
    { id: "browser", label: "Browser (SPA)", icon: "client" },
    { id: "apigw", label: "API Gateway", sublabel: "HTTP API", icon: "api-gateway", group: "cloud" },
    { id: "ws", label: "WebSocket API", icon: "api-gateway", group: "realtime" },
    { id: "s3", label: "S3", sublabel: "assets bucket", icon: "s3", group: "cloud" },
    { id: "sns", label: "Events topic", icon: "sns", group: "cloud" },
    { id: "docdb", label: "Event store", sublabel: "DocumentDB", icon: "documentdb", group: "vpc" },
    { id: "mailpit", label: "mailpit", sublabel: "Fargate", icon: "ecs-task", group: "cluster" },
    { id: "web", label: "web", sublabel: "Fargate", icon: "ecs-task", group: "cluster" },
    { id: "redis", label: "ElastiCache", icon: "elasticache", group: "cloud" },
    { id: "lambda", label: "events-pipeline", icon: "lambda", group: "fns" },
    { id: "cw", label: "CloudWatch", sublabel: "Logs + Metrics", icon: "cloudwatch", group: "cloud" },
    { id: "alb", label: "ALB", sublabel: "internal", icon: "alb", group: "vpc" },
    { id: "dynamodb", label: "DynamoDB", sublabel: "ws-connections", icon: "dynamodb", group: "realtime" },
    { id: "sqs", label: "SQS", sublabel: "events + notif", icon: "sqs", group: "cloud" },
    { id: "orders", label: "orders", sublabel: "Fargate", icon: "ecs-task", group: "backend" },
    { id: "eb", label: "EventBridge", sublabel: "metrics tick", icon: "eventbridge", group: "cloud" },
    { id: "o2", label: "openobserve", sublabel: "Fargate", icon: "ecs-task", group: "cluster" },
    { id: "tracking", label: "tracking", sublabel: "Fargate", icon: "ecs-task", group: "backend" },
    { id: "users", label: "users", sublabel: "Fargate", icon: "ecs-task", group: "backend" },
    { id: "cognito", label: "Cognito", sublabel: "user pool", icon: "cognito", group: "cloud" },
    { id: "rds", label: "RDS", sublabel: "Postgres + MySQL", icon: "rds", group: "vpc" },
    { id: "ws-fns", label: "WS Lambdas", sublabel: "4 functions", icon: "lambda", group: "fns" },
    { id: "ecr", label: "ECR", sublabel: "7 images", icon: "ecr", group: "cloud" },
    { id: "config", label: "SSM + Secrets Manager", sublabel: "params · secrets · RDS creds", icon: "ssm", group: "cloud" },
    { id: "cognito-fns", label: "Cognito triggers", sublabel: "pre-token + OTP", icon: "lambda", group: "fns" },
    { id: "dlq", label: "DLQ", sublabel: "both queues", icon: "sqs", group: "cloud" },
    { id: "otel", label: "otel-collector", sublabel: "Fargate", icon: "ecs-task", group: "cluster" },
    { id: "ses", label: "SES", icon: "ses", group: "cloud" },
  ],
  edges: [
    { id: "browser-alb", from: "browser", to: "alb", label: "SPA :9090" },
    { id: "lambda-ses", from: "lambda", to: "ses" },
    { id: "ecr-cluster", from: "ecr", to: "cluster", label: "images" },
    // WHY: realtime is exactly the WebSocket API and the connections table: Users and the pipeline query
    // the table and post to @connections; neither invokes the WS Lambdas.
    { id: "users-realtime", from: "users", to: "realtime", label: "push" },
    { id: "orders-users", from: "orders", to: "users" },
    { id: "eb-lambda", from: "eb", to: "lambda", label: "rate(1 min)", async: true },
    { id: "users-cognito", from: "users", to: "cognito", label: "admin API" },
    { id: "tracking-users", from: "tracking", to: "users" },
    { id: "config-cluster", from: "config", to: "cluster", label: "task config" },
    { id: "lambda-docdb", from: "lambda", to: "docdb" },
    { id: "ws-fns", from: "ws", to: "ws-fns", label: "routes" },
    // WHY: every one of the seven ECS services has its own listener and target group (modules/ecs-service).
    { id: "alb-cluster", from: "alb", to: "cluster", label: "listener per service" },
    { id: "otel-o2", from: "otel", to: "o2" },
    { id: "sqs-dlq", from: "sqs", to: "dlq", label: "redrive", async: true },
    { id: "backend-otel", from: "backend", to: "otel", label: "traces" },
    { id: "browser-s3", from: "browser", to: "s3", label: "images" },
    { id: "cognito-fns", from: "cognito", to: "cognito-fns", label: "triggers" },
    { id: "fns-sqs", from: "cognito-fns", to: "sqs", label: "OTP event", async: true },
    { id: "browser-ws", from: "browser", to: "ws", label: "socket" },
    { id: "sqs-lambda", from: "sqs", to: "lambda", label: "events", async: true },
    // WHY: every task logs through the awslogs driver; the backend tasks also PutMetricData.
    { id: "cluster-cw", from: "cluster", to: "cw", label: "logs + metrics" },
    { id: "sns-sqs", from: "sns", to: "sqs", async: true },
    { id: "apigw-cognito", from: "apigw", to: "cognito", label: "JWT authorizer" },
    { id: "backend-sns", from: "backend", to: "sns", async: true },
    { id: "backend-rds", from: "backend", to: "rds", label: "SQL" },
    { id: "browser-apigw", from: "browser", to: "apigw", label: "/v1 via web" },
    { id: "cw-otel", from: "cw", to: "otel", label: "logs + GetMetricData" },
    { id: "apigw-alb", from: "apigw", to: "alb", label: "routes" },
    { id: "sqs-users", from: "sqs", to: "users", label: "notify", async: true },
    { id: "ws-fns-dynamodb", from: "ws-fns", to: "dynamodb", label: "connections" },
    { id: "ses-mailpit", from: "ses", to: "mailpit", label: "SMTP" },
    { id: "backend-redis", from: "backend", to: "redis" },
    { id: "lambda-realtime", from: "lambda", to: "realtime", label: "fan-out" },
    // WHY: Terraform gives the Cognito triggers no log group and no logs permission (modules/cognito);
    // their logs land only because Floci auto-creates log groups.
    { id: "fns-cw", from: "fns", to: "cw", label: "logs + pipeline metrics" },
    { id: "lambda-otel", from: "lambda", to: "otel", label: "traces" },
    { id: "ws-fns-otel", from: "ws-fns", to: "otel", label: "traces" },
    { id: "web-otel", from: "web", to: "otel", label: "RUM :4319" },
  ],
  steps: [],
};
