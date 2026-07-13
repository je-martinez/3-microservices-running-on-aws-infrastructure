import { z } from "zod/v4";

// Mirrors the real Cognito PostConfirmation event (verified against the AWS docs
// and a live Floci pool). The event carries NO timestamp and no per-delivery
// unique field — a retry is byte-identical. That is why the idempotency key is
// derived rather than transmitted (spec D4).
//
// Note: the real event also has a top-level `response` field. It is
// deliberately NOT modeled here — it's trigger-outbound data the Lambda echoes
// back to Cognito, not captured state — so `.parse()` strips it and it is not
// retained in raw_payload.
//
// The triggerSource enum is the gate enforcing spec D5: PostConfirmation only.
// Adding a recurring trigger (e.g. PostAuthentication) requires reworking the
// derived message_id first, or only the first occurrence would ever be stored.
export const cognitoWebhookPayloadSchema = z.object({
  version: z.string(),
  triggerSource: z.enum([
    "PostConfirmation_ConfirmSignUp",
    "PostConfirmation_ConfirmForgotPassword",
  ]),
  region: z.string(),
  userPoolId: z.string(),
  userName: z.string(),
  callerContext: z.object({
    awsSdkVersion: z.string(),
    clientId: z.string(),
  }),
  request: z.object({
    // passthrough: raw_payload must retain custom attributes we don't model.
    userAttributes: z
      .object({
        sub: z.string().uuid(),
        email: z.string().email(),
        email_verified: z.union([z.boolean(), z.string()]).optional(),
      })
      .passthrough(),
  }),
});

export type CognitoWebhookPayload = z.infer<typeof cognitoWebhookPayloadSchema>;
