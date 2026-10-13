import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// WHY: local dev — make bootstrap and both Terraform roots run on the host, the services in
// Docker Compose; the RDS clusters take module.networking's subnets on Floci, S3, DynamoDB and
// Secrets Manager are regional. Both roots lock through the same DynamoDB table (backend.hcl) and
// their awscli-fallback scripts record runs in the execution-log table
// (infra/environments/local/{main.tf,backend,post}, infra/modules/tf-backend).
export const terraformTwoPhaseApply: z.input<typeof AwsDiagramData> = {
  title: "Two-phase Terraform apply in make bootstrap",
  subtitle: "Local dev: DB providers need a live endpoint, so app-users live in a second root",
  direction: "RIGHT",
  groups: [
    { id: "host", kind: "corporate", label: "Developer machine" },
    { id: "compose", kind: "generic", label: "Docker Compose: services" },
    { id: "floci", kind: "local-floci", label: "Floci (:4566)" },
    { id: "vpc", kind: "vpc", label: "VPC 10.0.0.0/16", parent: "floci" },
    { id: "subnets", kind: "public-subnet", label: "Subnets a + b", parent: "vpc" },
  ],
  nodes: [
    { id: "op", label: "make bootstrap", icon: "server", group: "host" },
    { id: "p1", label: "Phase 1 root", sublabel: "Terraform", icon: "server", group: "host" },
    { id: "p2", label: "Phase 2 root", sublabel: "Terraform, post/", icon: "server", group: "host" },
    { id: "services", label: "Services", icon: "server", group: "compose" },
    { id: "s3", label: "S3 buckets", sublabel: "state + assets", icon: "s3", group: "floci" },
    { id: "ddb", label: "DynamoDB", sublabel: "tf lock + execution log", icon: "dynamodb", group: "floci" },
    { id: "sm", label: "Secrets Manager", icon: "secrets-manager", group: "floci" },
    { id: "rds", label: "RDS clusters", icon: "rds", group: "subnets" },
  ],
  edges: [
    { id: "op-s3", from: "op", to: "s3", label: "state backend" },
    { id: "op-ddb", from: "op", to: "ddb", label: "lock + log tables" },
    { id: "op-p1", from: "op", to: "p1", label: "apply" },
    { id: "p1-rds", from: "p1", to: "rds", label: "create" },
    { id: "p1-s3", from: "p1", to: "s3", label: "write state" },
    { id: "p1-ddb", from: "p1", to: "ddb", label: "lock, run log" },
    { id: "op-services", from: "op", to: "services", label: "converge" },
    { id: "op-p2", from: "op", to: "p2", label: "apply post" },
    { id: "p2-s3", from: "p2", to: "s3", label: "state, assets" },
    { id: "p2-ddb", from: "p2", to: "ddb", label: "lock, run log" },
    { id: "p2-sm", from: "p2", to: "sm", label: "master secret" },
    { id: "p2-rds", from: "p2", to: "rds", label: "app-users" },
  ],
  steps: [
    { edges: ["op-s3", "op-ddb"], caption: "The backend root creates the state bucket, lock table and execution-log table first" },
    { edges: ["op-p1", "p1-ddb"], caption: "Base infra under the state lock; each awscli-fallback script records its run" },
    { edges: ["p1-rds"], caption: "The endpoint exists only after this apply, too late for a DB provider in the same root" },
    { edges: ["p1-s3"], caption: "Outputs include the cluster endpoints and the master secret's ARN" },
    { edges: ["op-services"], caption: "Env files, migrations and services; safe to re-run, unlike the phase-1 apply" },
    { edges: ["op-p2", "p2-ddb"], caption: "A separate root with its own state key, same lock table; fails without phase 1" },
    { edges: ["p2-s3"], caption: "terraform_remote_state yields the endpoints and the secret ARN" },
    { edges: ["p2-sm"], caption: "Credentials configure the postgresql and mysql providers against the live clusters" },
    { edges: ["p2-rds"], caption: "wait_for_db blocks until the DB accepts connections; app-users get no DELETE" },
    { edges: ["p2-s3"], caption: "Phase 2 also owns the bucket the email templates load their images from" },
  ],
};
