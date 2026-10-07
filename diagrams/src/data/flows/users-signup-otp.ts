import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: local dev. Users runs in Docker Compose; Cognito, both Lambdas, SNS, SQS and SES run on
// Floci outside the VPC; only the Users DB sits in module.networking's subnets. Sources: the watched
// Users commands, infra/modules/cognito/otp-challenge-lambda, infra/environments/local/main.tf.
export const usersSignupOtp: z.input<typeof AwsDiagramData> = {
  title: "Passwordless sign-up, then the first emailed code",
  subtitle: "Local dev on Floci: Users creates the Cognito user and its row, then starts a CUSTOM_AUTH challenge",
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
    { id: "cognito", label: "Cognito", sublabel: "user pool", icon: "cognito", group: "floci" },
    { id: "db", label: "Users DB", sublabel: "RDS PostgreSQL", icon: "rds", group: "subnets" },
    { id: "sns", label: "Events topic", icon: "sns", group: "floci" },
    { id: "otp", label: "OTP trigger", icon: "lambda", group: "floci" },
    { id: "sqs", label: "Events queue", icon: "sqs", group: "floci" },
    { id: "pipeline", label: "Events pipeline", icon: "lambda", group: "floci" },
    { id: "ses", label: "SES", sublabel: "Mailpit", icon: "ses", group: "floci" },
  ],
  edges: [
    { id: "web-users", from: "web", to: "users", label: "REST" },
    { id: "users-cognito", from: "users", to: "cognito", label: "SignUp, auth" },
    { id: "users-db", from: "users", to: "db" },
    { id: "users-sns", from: "users", to: "sns", label: "USER_CREATED", async: true },
    { id: "cognito-otp", from: "cognito", to: "otp", label: "trigger" },
    { id: "sns-sqs", from: "sns", to: "sqs", async: true },
    { id: "otp-sqs", from: "otp", to: "sqs", label: "AUTH_OTP_REQUESTED", async: true },
    { id: "sqs-pipeline", from: "sqs", to: "pipeline", async: true },
    { id: "pipeline-ses", from: "pipeline", to: "ses", label: "email" },
  ],
  steps: [
    { edges: ["web-users"], caption: "The browser sends a name and an email; no password is chosen on this path" },
    { edges: ["users-cognito"], caption: "Users signs the user up with a random password it never logs, returns or stores" },
    { edges: ["users-db"], caption: "The row keeps the Cognito sub and auth type PASSWORDLESS in the Users DB" },
    { edges: ["users-sns", "sns-sqs", "sqs-pipeline"], caption: "Published to the SNS topic; the events queue delivers it to the pipeline Lambda" },
    { edges: ["pipeline-ses"], caption: "The pipeline validates the payload and sends the welcome email through SES" },
    { edges: ["web-users"], caption: "Right after sign-up, the browser asks Users to start a code challenge" },
    { edges: ["users-cognito"], caption: "Users opens a CUSTOM_AUTH session and returns its opaque session to the browser" },
    { edges: ["cognito-otp"], caption: "The trigger mints a 6-digit code held only in the private challenge" },
    { edges: ["otp-sqs", "sqs-pipeline", "pipeline-ses"], caption: "The trigger sends the event straight to SQS; the pipeline emails the code via SES" },
    { edges: ["web-users", "users-cognito", "cognito-otp"], caption: "Users answers the challenge; the trigger checks the code and Cognito issues tokens" },
  ],
};
