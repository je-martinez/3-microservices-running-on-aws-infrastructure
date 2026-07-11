import { z } from "zod/v4";
import { cognitoWebhookPayloadSchema } from "../webhooks/cognito-payload.ts";

// Re-export so the route file imports webhook + all http schemas from one place.
// The payload schema is the single source of truth (see webhooks/cognito-payload.ts);
// it is documented in the spec but validated inside the handler to preserve the
// 422-on-invalid contract (see plan Global Constraints).
export { cognitoWebhookPayloadSchema };

// ---- Request bodies ----
export const RegisterInputSchema = z.object({
  email: z.string().email().describe("New user's email"),
  password: z.string().describe("Plaintext password (sent to the auth provider)"),
  fullName: z.string().describe("Display name"),
  address: z.unknown().optional().describe("Free-form structured address (stored as JSON)"),
  phoneNumber: z.string().optional(),
});

export const LoginInputSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const UpdateProfileInputSchema = z.object({
  fullName: z.string().optional(),
  address: z.unknown().optional(),
  phoneNumber: z.string().optional(),
});

// ---- Responses ----
export const UserSchema = z
  .object({
    id: z.string().describe("Prefixed nano id, e.g. usr_V1StGXR8Z5"),
    email: z.string().email(),
    fullName: z.string(),
    address: z.unknown().nullable(),
    phoneNumber: z.string().nullable(),
    tags: z.array(z.string()),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    updatedBy: z.string().nullable(),
    updatedAt: z.string(),
    deletedBy: z.string().nullable(),
    deletedAt: z.string().nullable(),
    isDeleted: z.boolean(),
  })
  .describe("A user profile");

export const AuthTokensSchema = z.object({
  idToken: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
});

export const ErrorSchema = z.object({
  error: z.string(),
});

export const HealthResponseSchema = z.object({ status: z.literal("ok") });
export const E2ECleanupResponseSchema = z.object({ deleted: z.number() });

// ---- Headers ----
export const UserIdHeader = z.object({
  "x-user-id": z.string().describe("Cognito subject forwarded by the API Gateway authorizer"),
});
export const WebhookSecretHeader = z.object({
  "x-webhook-secret": z.string().describe("Shared secret guarding the Cognito webhook"),
});

// Register reusable component ids so they appear under components/schemas
// (via jsonSchemaTransformObject) and are referenced by $ref in the spec.
z.globalRegistry.add(UserSchema, { id: "User" });
z.globalRegistry.add(AuthTokensSchema, { id: "AuthTokens" });
z.globalRegistry.add(ErrorSchema, { id: "Error" });
