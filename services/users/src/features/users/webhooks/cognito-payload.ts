import { z } from "zod/v4";

// CONTRACT: The triggerSource enum is the gate — PostConfirmation only. Adding a
// recurring trigger (PostAuthentication) requires reworking the derived message_id
// first, or only the first occurrence is ever stored. The event carries no timestamp
// and no per-delivery unique field, so a retry is byte-identical, which is why the
// idempotency key is derived. `response` is deliberately unmodelled: it is
// trigger-outbound data, so `.parse()` strips it from raw_payload.
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
