import type { FlowData } from "../../schema";

export const usersCognitoIdentityWebhook: FlowData = {
  title: "Cognito identity capture",
  subtitle: "One capture command, two entries: in-process on register, or the secret-guarded webhook",
  actors: [
    { id: "web", label: "Web app", kind: "external" },
    { id: "caller", label: "Webhook caller", kind: "external" },
    { id: "users", label: "Users service", kind: "compute", aws: "ecs" },
    { id: "capture", label: "Identity capture", kind: "compute" },
    { id: "db", label: "Users Postgres", kind: "data", aws: "aurora" },
    { id: "cognito", label: "Cognito", kind: "edge", aws: "cognito" },
  ],
  steps: [
    { from: "web", to: "users", label: "Register", caption: "A password or passwordless sign-up reaches the Users register command" },
    { from: "users", to: "cognito", label: "AdminCreateUser", caption: "Users creates the Cognito user and keeps its sub, email and verified flag" },
    { from: "users", to: "db", label: "Insert user", caption: "The users row is written with the Cognito sub stamped on it" },
    { from: "users", to: "capture", label: "In-process call", caption: "Outside production, register calls the capture command directly; no HTTP hop" },
    { from: "capture", to: "db", label: "Snapshot + event", caption: "One nested upsert writes the identity snapshot and its event in a transaction" },
    { from: "capture", to: "capture", label: "Derived message id", caption: "The id hashes sub and trigger source, so a retry hits the unique index" },
    { from: "users", to: "web", label: "201", caption: "A failed capture is logged and never fails the registration" },
    { from: "caller", to: "users", label: "Webhook + secret", caption: "The HTTP entry for a PostConfirmation shim (deferred); secret checked timing-safe" },
    { from: "users", to: "capture", label: "Validated payload", caption: "A valid payload reaches the same command; no matching user answers 500" },
  ],
};
