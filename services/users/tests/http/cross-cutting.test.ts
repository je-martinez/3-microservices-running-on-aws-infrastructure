import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Body, Controller, Get, Module, Post } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { z } from "zod/v4";

import { ZodValidationPipe } from "#shared/http/zod-validation.pipe";
import { DomainExceptionFilter } from "#shared/http/domain-exception.filter";
import { InvalidCredentialsError } from "#shared/auth/auth-errors";
import { RecordNotFoundError } from "#shared/db/db-errors";
import { CascadeError } from "#shared/http/cascade-client";

const BodySchema = z.object({ email: z.string().email() });

@Controller("v1/probe")
class ProbeController {
  @Post("validate")
  validate(@Body(new ZodValidationPipe(BodySchema)) body: { email: string }): { email: string } {
    return body;
  }

  @Get("auth-error")
  authError(): never {
    throw new InvalidCredentialsError();
  }

  @Get("not-found")
  notFound(): never {
    throw new RecordNotFoundError();
  }

  @Get("cascade-error")
  cascadeError(): never {
    throw new CascadeError("orders leg did not confirm");
  }
}

// Self-contained probe module — no AppModule. Registers the filter locally so
// this suite passes while other workers still own main.ts / app.module.ts.
@Module({
  controllers: [ProbeController],
  providers: [{ provide: APP_FILTER, useClass: DomainExceptionFilter }],
})
class ProbeModule {}

describe("HTTP cross-cutting behaviour", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("accepts a body that satisfies the schema", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/probe/validate",
      payload: { email: "ada@example.com" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ email: "ada@example.com" });
  });

  it("rejects an invalid body with the Fastify FST_ERR_VALIDATION contract", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/probe/validate",
      payload: { email: "not-an-email" },
    });

    expect(response.statusCode).toBe(400);
    // Exact shape from Fastify + fastify-type-provider-zod validatorCompiler.
    expect(response.json()).toEqual({
      statusCode: 400,
      code: "FST_ERR_VALIDATION",
      error: "Bad Request",
      message: "body/email Invalid email address",
    });
  });

  it("maps an AuthError to its own status and code", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/probe/auth-error" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_credentials" });
  });

  it("maps a RecordNotFoundError to 404 not_found", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/probe/not-found" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });

  it("maps a CascadeError to 502 cascade_failed", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/probe/cascade-error",
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "cascade_failed" });
  });
});
