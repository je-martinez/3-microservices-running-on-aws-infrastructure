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

// No `password` field: the account is created with a random one the caller
// never sees, and `authType` is read-only (set to PASSWORDLESS by the route's
// command, never accepted from a request body).
export const RegisterPasswordlessInputSchema = z.object({
  email: z.string().email().describe("New passwordless user's email"),
  fullName: z.string().describe("Display name"),
  address: z.unknown().optional().describe("Free-form structured address (stored as JSON)"),
  phoneNumber: z.string().optional(),
});

export const LoginInputSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const OtpStartInputSchema = z.object({
  email: z.string().email(),
});

export const OtpVerifyInputSchema = z.object({
  email: z.string().email(),
  session: z.string().min(1).describe("Opaque challenge session returned by /v1/users/otp/start"),
  // Length + shape are validated, but the value NEVER reaches a log line — not
  // even through a Zod error message, which is why the regex message is a fixed
  // string that does not echo the input.
  code: z.string().length(6).regex(/^\d{6}$/, "code must be 6 digits"),
});

export const RefreshInputSchema = z.object({
  refreshToken: z.string().min(1),
});

// ---- Password reset (self-owned flow) ----
// Minimum length only, no composition rules: Cognito's own user-pool password
// policy is the authority on what a valid password is, and duplicating it here
// would create two rules that drift. A too-weak password is rejected by
// AdminSetUserPassword with `InvalidPasswordException`; this bound just avoids
// a round trip for the obviously-empty case.
const NewPasswordSchema = z
  .string()
  .min(8)
  .describe("The new plaintext password. Validated against the Cognito user pool's password policy.");

export const ForgotPasswordInputSchema = z.object({
  email: z.string().email().describe("Email of the account to reset"),
});

export const ConfirmPasswordResetInputSchema = z.object({
  email: z.string().email(),
  // Same treatment as the OTP code: shape is validated, but the value NEVER
  // reaches a log line — the regex message is a fixed string that does not echo
  // the input (a Zod message that quoted it would leak the credential into the
  // 400 response body and any log of it).
  code: z.string().length(6).regex(/^\d{6}$/, "code must be 6 digits"),
  newPassword: NewPasswordSchema,
});

// The body of PATCH /v1/users/me/password. Exactly ONE field: this endpoint sets
// a password and does nothing else, so it must not be able to carry `fullName`,
// `address` or anything else a general profile update accepts.
export const ChangePasswordInputSchema = z.object({
  newPassword: NewPasswordSchema,
});

// Deliberately empty of anything derived from the request: the endpoint answers
// identically whether or not the email exists (no user enumeration), so the body
// is a fixed acknowledgement with nothing in it to compare between two calls.
export const PasswordResetAcceptedSchema = z
  .object({ status: z.literal("accepted") })
  .describe(
    "Fixed acknowledgement. Returned whether or not the email belongs to an account — " +
      "the response must not reveal which, by design.",
  );

export const PasswordResetConfirmedSchema = z.object({ status: z.literal("password_updated") });

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
    authType: z
      .enum(["PASSWORD", "PASSWORDLESS"])
      .describe(
        "Read-only. PASSWORDLESS accounts have no usable password and authenticate via OTP only.",
      ),
    mustChangePassword: z
      .boolean()
      .describe(
        "Read-only. True when the frontend MUST send the user through " +
          "PATCH /v1/users/me/password before letting them continue. Cleared by that " +
          "endpoint and by POST /v1/users/password/confirm.",
      ),
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

// The verify step returns the SAME AuthTokensSchema as password login, so the
// gateway/JWT contract is identical whichever path issued the tokens.
export const OtpStartResponseSchema = z.object({
  session: z.string().describe("Opaque challenge session to hand back to /v1/users/otp/verify"),
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
// Response schemas: the id IS the component name.
z.globalRegistry.add(UserSchema, { id: "User" });
z.globalRegistry.add(AuthTokensSchema, { id: "AuthTokens" });
z.globalRegistry.add(ErrorSchema, { id: "Error" });
z.globalRegistry.add(PasswordResetAcceptedSchema, { id: "PasswordResetAccepted" });
z.globalRegistry.add(PasswordResetConfirmedSchema, { id: "PasswordResetConfirmed" });

// Request-body schemas: the provider suffixes the request variant with "Input",
// so registering with id "Register" yields a "RegisterInput" component. Naming
// the bodies (instead of leaving them inline/anonymous) makes them show as
// proper, named models when the spec is imported into Apidog.
z.globalRegistry.add(RegisterInputSchema, { id: "Register" });
z.globalRegistry.add(RegisterPasswordlessInputSchema, { id: "RegisterPasswordless" });
z.globalRegistry.add(LoginInputSchema, { id: "Login" });
z.globalRegistry.add(OtpStartInputSchema, { id: "OtpStart" });
z.globalRegistry.add(OtpVerifyInputSchema, { id: "OtpVerify" });
z.globalRegistry.add(RefreshInputSchema, { id: "Refresh" });
z.globalRegistry.add(UpdateProfileInputSchema, { id: "UpdateProfile" });
z.globalRegistry.add(ForgotPasswordInputSchema, { id: "ForgotPassword" });
z.globalRegistry.add(ConfirmPasswordResetInputSchema, { id: "ConfirmPasswordReset" });
z.globalRegistry.add(ChangePasswordInputSchema, { id: "ChangePassword" });
