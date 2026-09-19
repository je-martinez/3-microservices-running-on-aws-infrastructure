import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Controller, Get, Module, Post } from "@nestjs/common";
import { ApiBody, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildOpenApiDocument } from "#shared/openapi/build-document";

// Component names present in the committed Fastify artifact
// (services/users/openapi.yaml). NotificationInput is an orphan twin that
// provider emits; Nest does not recreate it.
const COMMITTED_COMPONENT_NAMES = [
  "AuthTokens",
  "ChangePasswordInput",
  "ConfirmPasswordResetInput",
  "Error",
  "ForgotPasswordInput",
  "LoginInput",
  "MarkReadInput",
  "MarkReadResult",
  "Notification",
  "NotificationsPage",
  "OtpStartInput",
  "OtpVerifyInput",
  "PasswordResetAccepted",
  "PasswordResetConfirmed",
  "RefreshInput",
  "RegisterInput",
  "RegisterPasswordlessInput",
  "UnreadCount",
  "UpdateProfileInput",
  "User",
] as const;

@Controller("v1/probe-openapi")
@ApiTags("users")
class ProbeOpenApiController {
  @Get("me")
  @ApiResponse({ status: 200, schema: { $ref: "#/components/schemas/User" } })
  @ApiResponse({ status: 404, schema: { $ref: "#/components/schemas/Error" } })
  me(): { id: string } {
    return { id: "usr_probe" };
  }

  @Post("login")
  @ApiBody({ schema: { $ref: "#/components/schemas/LoginInput" } })
  @ApiResponse({ status: 200, schema: { $ref: "#/components/schemas/AuthTokens" } })
  @ApiResponse({ status: 401, schema: { $ref: "#/components/schemas/Error" } })
  login(): { idToken: string; accessToken: string; refreshToken: string } {
    return { idToken: "t", accessToken: "t", refreshToken: "t" };
  }
}

// Self-contained probe — no AppModule. Controllers owned by other workers are
// not available yet; buildOpenApiDocument must work against any INestApplication.
@Module({ controllers: [ProbeOpenApiController] })
class ProbeOpenApiModule {}

describe("generated OpenAPI document", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeOpenApiModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  function document() {
    return buildOpenApiDocument(app);
  }

  it("resolves every request and response schema to a NAMED $ref", () => {
    const doc = document();
    const inlined: string[] = [];

    for (const [path, methods] of Object.entries(doc.paths ?? {})) {
      for (const [method, operation] of Object.entries(methods as Record<string, unknown>)) {
        if (method.startsWith("x-") || typeof operation !== "object" || operation === null) {
          continue;
        }
        const op = operation as {
          requestBody?: {
            content?: { "application/json"?: { schema?: Record<string, unknown> } };
          };
          responses?: Record<
            string,
            { content?: { "application/json"?: { schema?: Record<string, unknown> } } }
          >;
        };
        const schemas = [
          op.requestBody?.content?.["application/json"]?.schema,
          ...Object.values(op.responses ?? {}).map(
            (entry) => entry?.content?.["application/json"]?.schema,
          ),
        ];
        for (const schema of schemas) {
          if (schema && !("$ref" in schema)) {
            inlined.push(`${method.toUpperCase()} ${path}`);
          }
        }
      }
    }

    expect(inlined).toEqual([]);
  });

  it("emits no orphan components", () => {
    const doc = document();
    const serialized = JSON.stringify(doc);
    const orphans = Object.keys(doc.components?.schemas ?? {}).filter(
      (name) => serialized.split(`"#/components/schemas/${name}"`).length - 1 < 1,
    );

    expect(orphans).toEqual([]);
  });

  it("keeps the component names the committed document already uses", () => {
    const doc = document();
    const names = Object.keys(doc.components?.schemas ?? {});

    // Probe routes $ref a subset; pruning drops the rest. Every survivor must
    // still be a name the committed Fastify artifact already used.
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(COMMITTED_COMPONENT_NAMES).toContain(name);
    }
    expect(names).toEqual(expect.arrayContaining(["User", "AuthTokens", "Error", "LoginInput"]));
  });

  it("materialises User as a real JSON Schema object, not an empty stub", () => {
    const doc = document();
    const user = doc.components?.schemas?.User as { type?: string; properties?: object } | undefined;

    expect(user?.type).toBe("object");
    expect(user?.properties).toMatchObject({
      id: expect.any(Object),
      email: expect.any(Object),
      fullName: expect.any(Object),
    });
  });
});
