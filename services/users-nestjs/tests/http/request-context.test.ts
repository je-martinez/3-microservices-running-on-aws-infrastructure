import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// CONTRACT: Seed env BEFORE any import of #config/config.module. That module's
// `@Module` decorator calls ConfigModule.forRoot at load time, and a missing
// var rejects asynchronously — Vitest reports an unhandled rejection even when
// every `it` passes. See [[env-files]]
Object.assign(process.env, {
  DATABASE_WRITER_URL: "http://127.0.0.1/db",
  DATABASE_READER_URL: "http://127.0.0.1/db",
  COGNITO_USER_POOL_ID: "pool",
  COGNITO_CLIENT_ID: "client",
  AWS_ENDPOINT_URL: "http://127.0.0.1:4566",
  AWS_REGION: "us-east-1",
  WEBHOOK_SECRET: "test-webhook-secret",
  INTERNAL_API_KEY: "test-api-key",
  ORDERS_BASE_URL: "http://127.0.0.1:3001",
  TRACKING_BASE_URL: "http://127.0.0.1:3002",
  EVENTS_TOPIC_ARN: "arn:aws:sns:us-east-1:000000000000:events",
  NOTIFICATIONS_QUEUE_URL: "http://127.0.0.1:4566/queue",
  WS_MANAGEMENT_ENDPOINT: "http://127.0.0.1:4566/execute-api/api/$default",
  WS_CONNECTIONS_TABLE: "ws-connections",
  REDIS_HOST: "127.0.0.1",
  REDIS_PORT: "6379",
  E2E_TESTING_ENABLED: "true",
});

const {
  Controller,
  Get,
  Module,
} = await import("@nestjs/common");
type MiddlewareConsumer = import("@nestjs/common").MiddlewareConsumer;
type NestModule = import("@nestjs/common").NestModule;
const { APP_GUARD } = await import("@nestjs/core");
const { Test } = await import("@nestjs/testing");
const { FastifyAdapter } = await import("@nestjs/platform-fastify");
type NestFastifyApplication = import("@nestjs/platform-fastify").NestFastifyApplication;
const { AppConfigService } = await import("#config/config.module");
const { actorContext } = await import("#shared/audit/actor-context");
const { AuthGuard } = await import("#shared/auth/auth.guard");
const { Public } = await import("#shared/auth/public.decorator");
const { RequestContextMiddleware } = await import("#shared/http/request-context.middleware");
const { getLogContext } = await import("#shared/logging/log-context");

@Controller("v1/probe")
class ProbeController {
  @Get()
  read(): {
    actor: string | undefined;
    request_id: string | undefined;
    run_id: string | undefined;
  } {
    return {
      actor: actorContext.getStore()?.actor,
      request_id: getLogContext().request_id,
      run_id: getLogContext().run_id,
    };
  }
}

@Controller("v1/public-probe")
class PublicProbeController {
  @Public()
  @Get()
  read(): { ok: true; actor: string | undefined; request_id: string | undefined } {
    return {
      ok: true,
      actor: actorContext.getStore()?.actor,
      request_id: getLogContext().request_id,
    };
  }
}

// Self-contained probe module — wires middleware + APP_GUARD locally so this
// suite passes while the owner still owns app.module.ts / main.ts.
@Module({
  controllers: [ProbeController, PublicProbeController],
  providers: [
    RequestContextMiddleware,
    {
      provide: AppConfigService,
      useValue: {
        get: (key: string) => (key === "E2E_TESTING_ENABLED" ? true : undefined),
      },
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
class ProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes("*");
  }
}

describe("request context middleware + auth guard", () => {
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

  it("carries the actor into the handler's AsyncLocalStorage store", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/probe",
      headers: { "x-user-id": "cognito-sub-1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().actor).toBe("cognito-sub-1");
  });

  it("seeds a request_id that reaches the handler", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/probe",
      headers: { "x-user-id": "cognito-sub-1" },
    });

    expect(response.json().request_id).toMatch(/^req_/);
  });

  it("seeds run_id from x-e2e-run-id when E2E_TESTING_ENABLED", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/probe",
      headers: {
        "x-user-id": "cognito-sub-1",
        "x-e2e-run-id": "run_abc123",
      },
    });

    expect(response.json().run_id).toBe("run_abc123");
  });

  it("omits run_id when the header is absent — never blank", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/probe",
      headers: { "x-user-id": "cognito-sub-1" },
    });

    expect(response.json()).not.toHaveProperty("run_id");
  });

  it("answers 401 unauthenticated when x-user-id is absent on a non-public route", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/probe" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthenticated" });
  });

  it("lets a @Public() route through with no x-user-id", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/public-probe" });

    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
    expect(response.json().request_id).toMatch(/^req_/);
  });

  it("keeps the actor store across an awaited async boundary", async () => {
    // A plain await is the same hazard shape as an awaited Prisma call: the
    // context must still be there on the far side of the microtask.
    // See [[2026-07-12-prisma-lazy-promise-als]]
    const seen: Array<string | undefined> = [];
    await actorContext.run({ actor: "cognito-sub-1" }, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      seen.push(actorContext.getStore()?.actor);
    });

    expect(seen).toEqual(["cognito-sub-1"]);
  });
});
