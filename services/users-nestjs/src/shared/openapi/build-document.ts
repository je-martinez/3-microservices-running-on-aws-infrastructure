import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { z, type ZodType } from "zod/v4";
import {
  UserSchema,
  AuthTokensSchema,
  ErrorSchema,
  HealthResponseSchema,
  RefreshedTokensSchema,
  OtpStartResponseSchema,
  PasswordResetAcceptedSchema,
  PasswordResetConfirmedSchema,
  E2ECleanupResponseSchema,
  RegisterInputSchema,
  RegisterPasswordlessInputSchema,
  LoginInputSchema,
  OtpStartInputSchema,
  OtpVerifyInputSchema,
  RefreshInputSchema,
  UpdateProfileInputSchema,
  ForgotPasswordInputSchema,
  ConfirmPasswordResetInputSchema,
  ChangePasswordInputSchema,
} from "#features/users/http/schemas";
import {
  NotificationsPageSchema,
  UnreadCountSchema,
  MarkReadResultSchema,
  MarkReadInputSchema,
  NotificationSchema,
} from "#features/notifications/http/schemas";

// CONTRACT: Zod schemas are the single source of truth for BOTH validation and
// OpenAPI shape. Each lands as a NAMED component so every route resolves to a
// $ref — an inline anonymous schema imports into Apidog as an unnamed blob.
// Names match services/users/openapi.yaml (minus the orphan NotificationInput
// twin Fastify's type provider emits). See [[openapi-specs]]
//
// WHY: `zod-to-json-schema` returns `{}` for Zod v4 schemas (this package
// imports `zod/v4`). Zod's native `z.toJSONSchema` is the working converter;
// an empty metadata registry mirrors `$refStrategy: "none"` so nested models
// stay inlined inside the component body.
const EMPTY_META = z.registry<Record<string, unknown>>();

const COMPONENTS: Record<string, ZodType> = {
  User: UserSchema,
  AuthTokens: AuthTokensSchema,
  Error: ErrorSchema,
  HealthResponse: HealthResponseSchema,
  RefreshedTokens: RefreshedTokensSchema,
  OtpStartResponse: OtpStartResponseSchema,
  PasswordResetAccepted: PasswordResetAcceptedSchema,
  PasswordResetConfirmed: PasswordResetConfirmedSchema,
  E2ECleanupResponse: E2ECleanupResponseSchema,
  RegisterInput: RegisterInputSchema,
  RegisterPasswordlessInput: RegisterPasswordlessInputSchema,
  LoginInput: LoginInputSchema,
  OtpStartInput: OtpStartInputSchema,
  OtpVerifyInput: OtpVerifyInputSchema,
  RefreshInput: RefreshInputSchema,
  UpdateProfileInput: UpdateProfileInputSchema,
  ForgotPasswordInput: ForgotPasswordInputSchema,
  ConfirmPasswordResetInput: ConfirmPasswordResetInputSchema,
  ChangePasswordInput: ChangePasswordInputSchema,
  NotificationsPage: NotificationsPageSchema,
  UnreadCount: UnreadCountSchema,
  MarkReadResult: MarkReadResultSchema,
  MarkReadInput: MarkReadInputSchema,
  Notification: NotificationSchema,
};

function toOpenApiSchema(schema: ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, {
    metadata: EMPTY_META,
    reused: "inline",
  }) as Record<string, unknown>;
  const { $schema: _schema, id: _id, $id: _dollarId, ...rest } = raw;
  return rest;
}

// Drops components nothing $refs — same behaviour as pruneOrphanComponents in
// the Fastify generator this replaces. Unreferenced schemas are Apidog noise.
function pruneOrphans(document: OpenAPIObject): OpenAPIObject {
  const schemas = document.components?.schemas;
  if (!schemas) return document;
  const serialized = JSON.stringify(document);
  for (const name of Object.keys(schemas)) {
    if (serialized.split(`"#/components/schemas/${name}"`).length - 1 < 1) {
      delete schemas[name];
    }
  }
  return document;
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle("Users Service API")
    .setVersion("1.0.0")
    .setDescription(
      "HTTP API for the 3MRAI Users microservice (NestJS + Aurora Postgres). " +
        "Identity is enforced at the API Gateway authorizer, which forwards the " +
        "Cognito subject as the x-user-id header.",
    )
    .addServer("http://localhost:3000", "Local (docker compose / Floci)")
    .addTag("health", "Liveness")
    .addTag("users", "Registration, auth and profile")
    .addTag("webhooks", "Inbound Cognito trigger (shared-secret guarded)")
    .addTag("notifications", "In-app notification inbox")
    .addTag("e2e", "Test-only routes (E2E_TESTING_ENABLED)")
    .build();

  const document = SwaggerModule.createDocument(app, config);
  document.components = document.components ?? {};
  document.components.schemas = {
    ...(document.components.schemas ?? {}),
    ...Object.fromEntries(
      Object.entries(COMPONENTS).map(([name, schema]) => [name, toOpenApiSchema(schema) as never]),
    ),
  };

  return pruneOrphans(document);
}
