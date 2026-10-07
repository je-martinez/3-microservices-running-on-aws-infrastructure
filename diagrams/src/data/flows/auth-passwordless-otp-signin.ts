import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: drawn as local dev. Users runs in Docker Compose; Cognito, both Lambdas, the shared
// events queue and SES run on Floci outside the VPC (no vpc_config). Sources:
// infra/modules/cognito/main.tf (otp_challenge Lambda, sqs:SendMessage on the events queue),
// services/users/src/users/commands/*-otp-challenge.command.ts, the auth-otp-requested handler.
export const authPasswordlessOtpSignin: z.input<typeof AwsDiagramData> = {
  title: "Passwordless sign-in with an emailed code",
  subtitle: "Cognito CUSTOM_AUTH: one trigger Lambda defines, creates and verifies the challenge (local dev)",
  direction: "RIGHT",
  groups: [
    { id: "compose", kind: "generic", label: "Docker Compose" },
    { id: "floci", kind: "local-floci", label: "Floci (:4566)" },
  ],
  nodes: [
    { id: "web", label: "Web app", sublabel: "browser", icon: "client" },
    { id: "users", label: "Users service", icon: "server", group: "compose" },
    { id: "cognito", label: "Cognito", icon: "cognito", group: "floci" },
    { id: "otp", label: "OTP trigger", sublabel: "CUSTOM_AUTH", icon: "lambda", group: "floci" },
    { id: "queue", label: "Events queue", icon: "sqs", group: "floci" },
    { id: "pipeline", label: "events-pipeline", icon: "lambda", group: "floci" },
    { id: "ses", label: "SES", sublabel: "Mailpit", icon: "ses", group: "floci" },
  ],
  edges: [
    { id: "web-users", from: "web", to: "users", label: "start / verify" },
    { id: "users-cognito", from: "users", to: "cognito", label: "CUSTOM_AUTH" },
    { id: "cognito-otp", from: "cognito", to: "otp", label: "challenge" },
    { id: "otp-queue", from: "otp", to: "queue", label: "AUTH_OTP_REQUESTED", async: true },
    { id: "queue-pipeline", from: "queue", to: "pipeline", async: true },
    { id: "pipeline-ses", from: "pipeline", to: "ses", label: "email code" },
  ],
  steps: [
    { edges: ["web-users"], caption: "The browser sends only the email, through a public gateway route with no JWT" },
    { edges: ["users-cognito"], caption: "Users opens a CUSTOM_AUTH session for that email with Cognito" },
    { edges: ["cognito-otp"], caption: "The trigger mints a 6-digit code and keeps it in the private challenge only" },
    { edges: ["otp-queue", "queue-pipeline"], caption: "The trigger queues the event on SQS; the code is never logged" },
    { edges: ["pipeline-ses"], caption: "The pipeline validates the envelope and emails the code through SES" },
    { edges: ["web-users"], caption: "Users returns the opaque Cognito session; the browser keeps it in memory" },
    { edges: ["web-users"], caption: "The browser sends the email, the session and the code the user typed" },
    { edges: ["users-cognito"], caption: "Users answers the CUSTOM_CHALLENGE with the submitted code" },
    { edges: ["cognito-otp"], caption: "The trigger compares in constant time; three wrong codes end the session" },
    { edges: ["users-cognito", "web-users"], caption: "Cognito issues tokens; the web app stores them, then loads the profile" },
  ],
};
