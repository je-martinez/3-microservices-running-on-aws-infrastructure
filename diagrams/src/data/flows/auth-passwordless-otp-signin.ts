import type { FlowData } from "../../schema";

export const authPasswordlessOtpSignin: FlowData = {
  title: "Passwordless sign-in with an emailed code",
  subtitle: "Cognito CUSTOM_AUTH: one trigger Lambda defines, creates and verifies the challenge",
  actors: [
    { id: "web", label: "Web app", kind: "external" },
    { id: "users", label: "Users service", kind: "compute", aws: "ecs" },
    { id: "cognito", label: "Cognito", kind: "edge", aws: "cognito" },
    { id: "otp", label: "OTP trigger", kind: "compute", aws: "lambda" },
    { id: "pipeline", label: "Events pipeline", kind: "compute", aws: "lambda" },
    { id: "ses", label: "SES", kind: "messaging", aws: "ses" },
  ],
  steps: [
    { from: "web", to: "users", label: "Start OTP", caption: "The browser sends only the email, through a public gateway route with no JWT" },
    { from: "users", to: "cognito", label: "CUSTOM_AUTH start", caption: "Users opens a CUSTOM_AUTH session for that email with Cognito" },
    { from: "cognito", to: "otp", label: "Create challenge", caption: "The trigger mints a 6-digit code and keeps it in the private challenge only" },
    { from: "otp", to: "pipeline", label: "AUTH_OTP_REQUESTED", caption: "The trigger queues the event on SQS; the code is never logged", async: true },
    { from: "pipeline", to: "ses", label: "Email code", caption: "The pipeline validates the envelope and emails the code through SES" },
    { from: "users", to: "web", label: "Session", caption: "Users returns the opaque Cognito session; the browser keeps it in memory" },
    { from: "web", to: "users", label: "Verify code", caption: "The browser sends the email, the session and the code the user typed" },
    { from: "users", to: "cognito", label: "Answer challenge", caption: "Users answers the CUSTOM_CHALLENGE with the submitted code" },
    { from: "cognito", to: "otp", label: "Verify answer", caption: "The trigger compares in constant time; three wrong codes end the session" },
    { from: "users", to: "web", label: "Tokens", caption: "Cognito issues tokens; the web app stores them, then loads the profile" },
  ],
};
