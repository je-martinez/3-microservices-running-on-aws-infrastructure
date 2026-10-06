import type { FlowData } from "../../schema";

export const usersSignupOtp: FlowData = {
  title: "Passwordless sign-up, then the first emailed code",
  subtitle: "Users creates the Cognito user and its row, then starts a CUSTOM_AUTH challenge",
  actors: [
    { id: "web", label: "Web app", kind: "external" },
    { id: "users", label: "Users service", kind: "compute", aws: "ecs" },
    { id: "db", label: "Users DB", kind: "data", aws: "aurora" },
    { id: "cognito", label: "Cognito", kind: "edge", aws: "cognito" },
    { id: "otp", label: "OTP trigger", kind: "compute", aws: "lambda" },
    { id: "pipeline", label: "Events pipeline", kind: "compute", aws: "lambda" },
    { id: "ses", label: "SES", kind: "messaging", aws: "ses" },
  ],
  steps: [
    { from: "web", to: "users", label: "Passwordless sign-up", caption: "The browser sends a name and an email; no password is chosen on this path" },
    { from: "users", to: "cognito", label: "Create user", caption: "Users signs the user up with a random password it never logs, returns or stores" },
    { from: "users", to: "db", label: "Insert user row", caption: "The row keeps the Cognito sub and auth type PASSWORDLESS in Aurora Postgres" },
    { from: "users", to: "pipeline", label: "USER_CREATED", caption: "Published to the SNS topic; the events queue delivers it to the pipeline Lambda", async: true },
    { from: "pipeline", to: "ses", label: "Welcome email", caption: "The pipeline validates the payload and sends the welcome email through SES" },
    { from: "web", to: "users", label: "Start OTP", caption: "Right after sign-up, the browser asks Users to start a code challenge" },
    { from: "users", to: "cognito", label: "CUSTOM_AUTH start", caption: "Users opens a CUSTOM_AUTH session and returns its opaque session to the browser" },
    { from: "cognito", to: "otp", label: "Create challenge", caption: "The trigger mints a 6-digit code held only in the private challenge" },
    { from: "otp", to: "pipeline", label: "AUTH_OTP_REQUESTED", caption: "The trigger sends the event straight to SQS; the pipeline emails the code via SES", async: true },
    { from: "web", to: "users", label: "Verify code", caption: "Users answers the challenge; the trigger checks the code and Cognito issues tokens" },
  ],
};
