import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: local dev. Users runs in Docker Compose; Cognito, ElastiCache, SNS, SQS, the pipeline
// Lambda and SES run on Floci outside the VPC (ElastiCache has no subnet group locally); only the
// Users DB sits in module.networking's subnets. Source: infra/environments/local/main.tf.
export const usersPasswordReset: z.input<typeof AwsDiagramData> = {
  title: "Self-owned password reset",
  subtitle: "Local dev on Floci: Users mints, stores and applies the code; Cognito's ForgotPassword is never called",
  direction: "RIGHT",
  groups: [
    { id: "compose", kind: "generic", label: "Docker Compose" },
    { id: "floci", kind: "local-floci", label: "Floci (:4566)" },
    { id: "vpc", kind: "vpc", label: "VPC 10.0.0.0/16", parent: "floci" },
    { id: "subnets", kind: "public-subnet", label: "Subnets a + b", parent: "vpc" },
  ],
  nodes: [
    { id: "web", label: "Web app", icon: "client" },
    { id: "users", label: "Users service", icon: "server", group: "compose" },
    { id: "db", label: "Users DB", sublabel: "RDS PostgreSQL", icon: "rds", group: "subnets" },
    { id: "redis", label: "Redis", sublabel: "ElastiCache", icon: "elasticache", group: "floci" },
    { id: "cognito", label: "Cognito", sublabel: "user pool", icon: "cognito", group: "floci" },
    { id: "sns", label: "Events topic", icon: "sns", group: "floci" },
    { id: "sqs", label: "Events queue", icon: "sqs", group: "floci" },
    { id: "pipeline", label: "Events pipeline", icon: "lambda", group: "floci" },
    { id: "ses", label: "SES", sublabel: "Mailpit", icon: "ses", group: "floci" },
  ],
  edges: [
    { id: "web-users", from: "web", to: "users", label: "REST" },
    { id: "users-db", from: "users", to: "db" },
    { id: "users-redis", from: "users", to: "redis", label: "code hash" },
    { id: "users-sns", from: "users", to: "sns", label: "PASSWORD_RESET_REQUESTED", async: true },
    { id: "sns-sqs", from: "sns", to: "sqs", async: true },
    { id: "sqs-pipeline", from: "sqs", to: "pipeline", async: true },
    { id: "pipeline-ses", from: "pipeline", to: "ses", label: "reset email" },
    { id: "users-cognito", from: "users", to: "cognito", label: "AdminSetUserPassword" },
  ],
  steps: [
    { edges: ["web-users"], caption: "The answer is identical whether or not the email belongs to an account" },
    { edges: ["users-db"], caption: "An unknown email stops here: no code minted, no event published" },
    { edges: ["users-redis"], caption: "A 6-digit code is minted; only its hash is stored, one key per email, 10-minute TTL" },
    { edges: ["users-sns", "sns-sqs", "sqs-pipeline"], caption: "Published via SNS to the events queue; a publish failure is logged, never returned" },
    { edges: ["pipeline-ses"], caption: "The pipeline renders the forgot-password email; the stored event has the code redacted" },
    { edges: ["web-users"], caption: "The browser sends the email, the code and the new password" },
    { edges: ["users-redis"], caption: "The code is checked against its hash and deleted; every failure is invalid_reset_code" },
    { edges: ["users-cognito"], caption: "Not ConfirmForgotPassword: Cognito rejects any code it did not mint itself" },
    { edges: ["users-db"], caption: "mustChangePassword is cleared and the cached profile invalidated" },
  ],
};
