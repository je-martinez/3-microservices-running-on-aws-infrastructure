import type { FlowData } from "../../schema";

export const usersPasswordReset: FlowData = {
  title: "Self-owned password reset",
  subtitle: "Users mints, stores and applies the code; Cognito's ForgotPassword is never called",
  actors: [
    { id: "web", label: "Web app", kind: "external" },
    { id: "users", label: "Users service", kind: "compute", aws: "ecs" },
    { id: "db", label: "Users DB", kind: "data", aws: "aurora" },
    { id: "redis", label: "Redis", kind: "data", aws: "elasticache" },
    { id: "cognito", label: "Cognito", kind: "edge", aws: "cognito" },
    { id: "pipeline", label: "Events pipeline", kind: "compute", aws: "lambda" },
    { id: "ses", label: "SES", kind: "messaging", aws: "ses" },
  ],
  steps: [
    { from: "web", to: "users", label: "Forgot password", caption: "The answer is identical whether or not the email belongs to an account" },
    { from: "users", to: "db", label: "Look up user", caption: "An unknown email stops here: no code minted, no event published" },
    { from: "users", to: "redis", label: "Store code hash", caption: "A 6-digit code is minted; only its hash is stored, one key per email, 10-minute TTL" },
    { from: "users", to: "pipeline", label: "PASSWORD_RESET_REQUESTED", caption: "Published via SNS to the events queue; a publish failure is logged, never returned", async: true },
    { from: "pipeline", to: "ses", label: "Reset code email", caption: "The pipeline renders the forgot-password email; the stored event has the code redacted" },
    { from: "web", to: "users", label: "Confirm reset", caption: "The browser sends the email, the code and the new password" },
    { from: "users", to: "redis", label: "Verify and consume", caption: "The code is checked against its hash and deleted; every failure is invalid_reset_code" },
    { from: "users", to: "cognito", label: "AdminSetUserPassword", caption: "Not ConfirmForgotPassword: Cognito rejects any code it did not mint itself" },
    { from: "users", to: "db", label: "Clear must-change flag", caption: "mustChangePassword is cleared and the cached profile invalidated" },
  ],
};
