import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// WHY: pre-prod — the Makefile and Terraform run on the host; pre-prod's own Floci is the cloud.
// ALB, ECS services and RDS take module.networking's subnets; ECR is regional
// (infra/environments/preprod/{main,services}.tf).
export const preprodDeploy: z.input<typeof AwsDiagramData> = {
  title: "How make preprod-up deploys pre-prod on Floci",
  subtitle: "Pre-prod: every service runs as an ECS task; never beside the dev environment",
  direction: "RIGHT",
  groups: [
    { id: "host", kind: "corporate", label: "Developer machine" },
    { id: "cloud", kind: "aws-cloud", label: "AWS Cloud (pre-prod Floci)" },
    { id: "vpc", kind: "vpc", label: "VPC", parent: "cloud" },
    { id: "subnets", kind: "public-subnet", label: "Subnets a + b", parent: "vpc" },
  ],
  nodes: [
    { id: "op", label: "Makefile", sublabel: "make preprod-up", icon: "server", group: "host" },
    { id: "tf", label: "Terraform", sublabel: "preprod root", icon: "server", group: "host" },
    { id: "floci", label: "Floci", sublabel: "pre-prod container", icon: "server", group: "cloud" },
    { id: "ecr", label: "ECR", icon: "ecr", group: "cloud" },
    { id: "rds", label: "RDS", icon: "rds", group: "subnets" },
    { id: "ecs", label: "ECS", sublabel: "one service each", icon: "ecs", group: "subnets" },
    { id: "alb", label: "ALB", icon: "elb", group: "subnets" },
  ],
  edges: [
    { id: "op-floci", from: "op", to: "floci", label: "guard + start" },
    { id: "op-tf", from: "op", to: "tf", label: "apply" },
    { id: "op-ecr", from: "op", to: "ecr", label: "build + push" },
    { id: "op-rds", from: "op", to: "rds", label: "migrate" },
    { id: "tf-ecs", from: "tf", to: "ecs", label: "services" },
    { id: "op-ecs", from: "op", to: "ecs", label: "wait, aliases" },
    { id: "op-alb", from: "op", to: "alb", label: "targets, smoke" },
    { id: "op-op", from: "op", to: "op", label: "dashboards + env" },
  ],
  steps: [
    { edges: ["op-floci"], caption: "Refuses beside dev or on a live pre-prod, then starts pre-prod's own Floci" },
    { edges: ["op-tf"], caption: "First apply with deploy_services=false: network, data stores, ECR and the cluster" },
    { edges: ["op-ecr"], caption: "Tags are unique per content; a tag already in ECR is reused, never rebuilt" },
    { edges: ["op-rds"], caption: "Prisma for users and golang-migrate for tracking, against Floci's RDS" },
    { edges: ["op-tf", "tf-ecs"], caption: "Second apply with deploy_services=true creates every ECS service on those tags" },
    { edges: ["op-ecs"], caption: "Counts RUNNING tasks of the primary deployment against each desired count" },
    { edges: ["op-alb"], caption: "Floci never deregisters a stopped task's IP, so stale targets are removed" },
    { edges: ["op-ecs"], caption: "Stable Docker aliases for the SMTP relay and gRPC; Floci names tasks randomly" },
    { edges: ["op-alb"], caption: "Health of every service through its ALB listener" },
    { edges: ["op-op"], caption: "Imports OpenObserve dashboards, writes .env.preprod.debug, starts stripe listen" },
  ],
};
