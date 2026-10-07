import type { FlowData } from "../../schema";

export const preprodDeploy: FlowData = {
  title: "How make preprod-up deploys pre-prod on Floci",
  subtitle: "Every service runs as an ECS task; never beside the dev environment",
  actors: [
    { id: "op", label: "Makefile", kind: "external" },
    { id: "floci", label: "Floci", kind: "compute" },
    { id: "tf", label: "Terraform", kind: "compute" },
    { id: "ecr", label: "ECR", kind: "data", aws: "ecr" },
    { id: "rds", label: "RDS", kind: "data", aws: "rds" },
    { id: "ecs", label: "ECS", kind: "compute", aws: "ecs" },
    { id: "alb", label: "ALB", kind: "edge", aws: "elb" },
  ],
  steps: [
    { from: "op", to: "floci", label: "Guard, start Floci", caption: "Refuses beside dev or on a live pre-prod, then starts pre-prod's own Floci" },
    { from: "op", to: "tf", label: "Apply, no services", caption: "First apply with deploy_services=false: network, data stores, ECR and the cluster" },
    { from: "op", to: "ecr", label: "Build + push images", caption: "Tags are unique per content; a tag already in ECR is reused, never rebuilt" },
    { from: "op", to: "rds", label: "Migrate schemas", caption: "Prisma for users and golang-migrate for tracking, against Floci's RDS" },
    { from: "tf", to: "ecs", label: "Apply with services", caption: "Second apply with deploy_services=true creates every ECS service on those tags" },
    { from: "op", to: "ecs", label: "Wait for tasks", caption: "Counts RUNNING tasks of the primary deployment against each desired count" },
    { from: "op", to: "alb", label: "Drop dead targets", caption: "Floci never deregisters a stopped task's IP, so stale targets are removed" },
    { from: "op", to: "ecs", label: "Attach aliases", caption: "Stable Docker aliases for the SMTP relay and gRPC; Floci names tasks randomly" },
    { from: "op", to: "alb", label: "Smoke each listener", caption: "Health of every service through its ALB listener" },
    { from: "op", to: "op", label: "Dashboards + env file", caption: "Imports OpenObserve dashboards, writes .env.preprod.debug, starts stripe listen" },
  ],
};
