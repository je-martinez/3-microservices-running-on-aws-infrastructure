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

export const RefreshInputSchema = z.object({
  refreshToken: z.string().min(1),
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

export const RefreshedTokensSchema = z.object({
  idToken: z.string(),
  accessToken: z.string(),
});

export const ErrorSchema = z.object({
  error: z.string(),
});

export const HealthResponseSchema = z.object({ status: z.literal("ok") });
export const E2ECleanupResponseSchema = z.object({ deleted: z.number() });

// ---- Headers ----
// Both headers are documented as `.optional()` even though the handlers treat
// them as effectively required: the *enforcement* (401 for a missing/invalid
// webhook secret, 404 for a missing actor on /me) happens inside the handler,
// not via schema validation — making the field non-optional here would make
// Fastify reject a missing header with its generic 400, breaking that contract.
export const UserIdHeader = z.object({
  "x-user-id": z
    .string()
    .optional()
    .describe(
      "Cognito subject forwarded by the API Gateway authorizer. Required in practice — " +
        "a request without it resolves no current user and is answered 404 (not a 400).",
    ),
});
export const WebhookSecretHeader = z.object({
  "x-webhook-secret": z
    .string()
    .optional()
    .describe(
      "Shared secret guarding the Cognito webhook. Required in practice — a missing or " +
        "wrong value is rejected 401 by the handler (not schema-validated to a 400).",
    ),
});

// Register reusable component ids so they appear under components/schemas
// (via jsonSchemaTransformObject) and are referenced by $ref in the spec.
z.globalRegistry.add(UserSchema, { id: "User" });
z.globalRegistry.add(AuthTokensSchema, { id: "AuthTokens" });
z.globalRegistry.add(ErrorSchema, { id: "Error" });
