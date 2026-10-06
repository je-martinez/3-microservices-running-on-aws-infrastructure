import type { FlowData } from "../../schema";

export const terraformTwoPhaseApply: FlowData = {
  title: "Two-phase Terraform apply in make bootstrap",
  subtitle: "DB providers need a live endpoint, so app-users live in a second root",
  actors: [
    { id: "op", label: "make bootstrap", kind: "external" },
    { id: "p1", label: "Phase 1 root", kind: "compute" },
    { id: "s3", label: "S3 buckets", kind: "data", aws: "s3" },
    { id: "rds", label: "RDS clusters", kind: "data", aws: "rds" },
    { id: "services", label: "Services", kind: "compute" },
    { id: "p2", label: "Phase 2 root", kind: "compute" },
    { id: "sm", label: "Secrets Manager", kind: "data", aws: "secrets-manager" },
  ],
  steps: [
    { from: "op", to: "s3", label: "Create state backend", caption: "The backend root creates the state bucket and lock table before either phase" },
    { from: "op", to: "p1", label: "Apply phase 1", caption: "Base infra: network, RDS clusters, Cognito, compute, API Gateway; no app-users" },
    { from: "p1", to: "rds", label: "Create clusters", caption: "The endpoint exists only after this apply, too late for a DB provider in the same root" },
    { from: "p1", to: "s3", label: "Write phase-1 state", caption: "Outputs include the cluster endpoints and the master secret's ARN" },
    { from: "op", to: "services", label: "Converge", caption: "Env files, migrations and services; safe to re-run, unlike the phase-1 apply" },
    { from: "op", to: "p2", label: "Apply post-infra", caption: "A separate root with its own state; it fails at the state read without phase 1" },
    { from: "p2", to: "s3", label: "Read remote state", caption: "terraform_remote_state yields the endpoints and the secret ARN" },
    { from: "p2", to: "sm", label: "Read master secret", caption: "Credentials configure the postgresql and mysql providers against the live clusters" },
    { from: "p2", to: "rds", label: "Gate + app-users", caption: "wait_for_db blocks until the DB accepts connections; app-users get no DELETE" },
    { from: "p2", to: "s3", label: "Assets bucket", caption: "Phase 2 also owns the bucket the email templates load their images from" },
  ],
};
