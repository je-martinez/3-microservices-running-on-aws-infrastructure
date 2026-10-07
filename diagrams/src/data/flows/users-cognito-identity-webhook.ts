import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: drawn as local dev. Users and its capture command run in Docker Compose; Cognito sits
// on Floci outside the VPC and the Users Postgres (RDS) in the VPC subnets. Sources:
// services/users/src/users/commands/register*.command.ts, services/users/src/features/users/webhooks/**.
export const usersCognitoIdentityWebhook: z.input<typeof AwsDiagramData> = {
  title: "Cognito identity capture",
  subtitle: "One capture command, two entries: in-process on register, or the secret-guarded webhook (local dev)",
  direction: "RIGHT",
  groups: [
    { id: "compose", kind: "generic", label: "Docker Compose" },
    { id: "floci", kind: "local-floci", label: "Floci (:4566)" },
    { id: "vpc", kind: "vpc", label: "VPC 10.0.0.0/16", parent: "floci" },
    { id: "subnets", kind: "public-subnet", label: "Subnets a + b", parent: "vpc" },
  ],
  nodes: [
    { id: "web", label: "Web app", sublabel: "browser", icon: "client" },
    { id: "caller", label: "Webhook caller", icon: "internet" },
    { id: "users", label: "Users service", icon: "server", group: "compose" },
    { id: "capture", label: "Identity capture", sublabel: "Users command", icon: "server", group: "compose" },
    { id: "cognito", label: "Cognito", icon: "cognito", group: "floci" },
    { id: "db", label: "Users Postgres", sublabel: "RDS", icon: "rds", group: "subnets" },
  ],
  edges: [
    { id: "web-users", from: "web", to: "users", label: "register" },
    { id: "caller-users", from: "caller", to: "users", label: "webhook + secret" },
    { id: "users-cognito", from: "users", to: "cognito", label: "AdminCreateUser" },
    { id: "users-db", from: "users", to: "db", label: "insert user" },
    { id: "users-capture", from: "users", to: "capture", label: "capture" },
    { id: "capture-db", from: "capture", to: "db", label: "snapshot + event" },
  ],
  steps: [
    { edges: ["web-users"], caption: "A password or passwordless sign-up reaches the Users register command" },
    { edges: ["users-cognito"], caption: "Users creates the Cognito user and keeps its sub, email and verified flag" },
    { edges: ["users-db"], caption: "The users row is written with the Cognito sub stamped on it" },
    { edges: ["users-capture"], caption: "Outside production, register calls the capture command directly; no HTTP hop" },
    { edges: ["capture-db"], caption: "One nested upsert writes the identity snapshot and its event in a transaction" },
    { edges: ["capture-db"], caption: "The id hashes sub and trigger source, so a retry hits the unique index" },
    { edges: ["web-users"], caption: "A failed capture is logged and never fails the registration" },
    { edges: ["caller-users"], caption: "The HTTP entry for a PostConfirmation shim (deferred); secret checked timing-safe" },
    { edges: ["users-capture"], caption: "A valid payload reaches the same command; no matching user answers 500" },
  ],
};
