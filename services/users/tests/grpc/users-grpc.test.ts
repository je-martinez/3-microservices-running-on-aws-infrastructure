import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type INestMicroservice, type MicroserviceOptions } from "@nestjs/microservices";
import { QueryBus } from "@nestjs/cqrs";
import { testSpanExporter } from "../setup.ts";
import { grpcMicroserviceOptions } from "../../src/users/grpc/grpc-options.ts";
import { UsersGrpcController } from "../../src/users/grpc/users-grpc.controller.ts";

// tests/grpc/ is four levels under the repo root (services/users/tests/grpc).
const PROTO = resolve(import.meta.dirname, "../../../../proto/users.proto");
const INBOUND_TRACE_ID = "1234567890abcdef1234567890abcdef";
const TRACEPARENT = `00-${INBOUND_TRACE_ID}-3250e3c0f6fbb7ab-01`;
const API_KEY = "test-grpc-key";
const URL = "127.0.0.1:50099";

// WHY: Provide QueryBus directly — importing CqrsModule and then overriding
// QueryBus leaves CqrsModule.onApplicationBootstrap calling `.register` on the
// mock and crashing listen(). The controller only needs `execute`.
const queryBus = { execute: vi.fn() };

@Module({
  controllers: [UsersGrpcController],
  providers: [{ provide: QueryBus, useValue: queryBus }],
})
class GrpcTestModule {}

describe("Users gRPC surface on @nestjs/microservices", () => {
  let app: INestMicroservice;
  let client: Record<string, Function>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GrpcTestModule] }).compile();

    app = moduleRef.createNestMicroservice<MicroserviceOptions>(
      grpcMicroserviceOptions({ GRPC_PORT: 50099, INTERNAL_API_KEY: API_KEY } as never),
    );
    await app.listen();

    const pkg = grpc.loadPackageDefinition(
      protoLoader.loadSync(PROTO, { keepCase: true, longs: String, defaults: true, oneofs: true }),
    ) as never as { users: { v1: { Users: new (...a: never[]) => Record<string, Function> } } };
    client = new pkg.users.v1.Users(URL, grpc.credentials.createInsecure());
  });

  afterAll(async () => {
    await app.close();
  });

  function call(metadata: grpc.Metadata): Promise<Record<string, unknown>> {
    return new Promise((res, rej) =>
      client.GetUserById({ id: "usr_1" }, metadata, (err: unknown, reply: never) =>
        err ? rej(err) : res(reply),
      ),
    );
  }

  it("joins the caller's trace — the server span is NOT a root", async () => {
    // CONTRACT: The JE-77 gate. The context is extracted in the api-key
    // interceptor and activated in onReceiveHalfClose, the continuation that
    // dispatches the async handler. Activating in onReceiveMetadata unwinds
    // first and yields two disjoint traces.
    // See [[grpc-context-activate-at-dispatch]]
    testSpanExporter.reset();
    queryBus.execute.mockResolvedValueOnce({
      id: "usr_1",
      email: "ada@example.com",
      fullName: "Ada",
      cognitoSub: "sub",
      address: null,
    });
    const md = new grpc.Metadata();
    md.set("x-api-key", API_KEY);
    md.set("traceparent", TRACEPARENT);

    await call(md);

    const span = testSpanExporter
      .getFinishedSpans()
      .find((s) => s.name === "users.v1.Users/GetUserById");
    expect(span).toBeDefined();
    expect(span!.spanContext().traceId).toBe(INBOUND_TRACE_ID);
  });

  it("rejects a wrong x-api-key with UNAUTHENTICATED", async () => {
    // CONTRACT: The interceptor-reached gate. GrpcOptions has no `interceptors`
    // key — passing them under `server:` is dropped SILENTLY and this call
    // returns the user's data instead of failing. This test is what catches it.
    const md = new grpc.Metadata();
    md.set("x-api-key", "wrong-key");

    await expect(call(md)).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
  });

  it("maps a missing user to NOT_FOUND", async () => {
    queryBus.execute.mockResolvedValueOnce(null);
    const md = new grpc.Metadata();
    md.set("x-api-key", API_KEY);

    await expect(call(md)).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
  });

  it("round-trips stripe_customer_id when the user has one set", async () => {
    queryBus.execute.mockResolvedValueOnce({
      id: "usr_1",
      email: "ada@example.com",
      fullName: "Ada",
      cognitoSub: "sub",
      address: null,
      stripeCustomerId: "cus_123",
    });
    const md = new grpc.Metadata();
    md.set("x-api-key", API_KEY);

    const reply = await call(md);

    expect(reply.stripe_customer_id).toBe("cus_123");
  });

  it("serializes a null stripeCustomerId as an empty string (proto3 has no null)", async () => {
    queryBus.execute.mockResolvedValueOnce({
      id: "usr_1",
      email: "ada@example.com",
      fullName: "Ada",
      cognitoSub: "sub",
      address: null,
      stripeCustomerId: null,
    });
    const md = new grpc.Metadata();
    md.set("x-api-key", API_KEY);

    const reply = await call(md);

    expect(reply.stripe_customer_id).toBe("");
  });
});
