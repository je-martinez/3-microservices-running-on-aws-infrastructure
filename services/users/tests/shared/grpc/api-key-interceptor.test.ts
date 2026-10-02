import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { context, propagation, trace } from "@opentelemetry/api";
import { apiKeyMatches, makeApiKeyInterceptor } from "#shared/grpc/api-key-interceptor";

// tests/shared/grpc/ is five levels under the repo root.
const PROTO = resolve(import.meta.dirname, "../../../../../proto/users.proto");
const API_KEY = "secret-key";
const INBOUND_TRACE_ID = "1234567890abcdef1234567890abcdef";
const TRACEPARENT = `00-${INBOUND_TRACE_ID}-3250e3c0f6fbb7ab-01`;

describe("apiKeyMatches", () => {
  it("returns true for identical keys", () => {
    expect(apiKeyMatches("secret-key", "secret-key")).toBe(true);
  });

  it("returns false for a same-length mismatch", () => {
    expect(apiKeyMatches("secret-kez", "secret-key")).toBe(false);
  });

  it("returns false when the key is missing", () => {
    expect(apiKeyMatches(undefined, "secret-key")).toBe(false);
  });

  it("returns false for an empty provided key", () => {
    expect(apiKeyMatches("", "secret-key")).toBe(false);
  });

  it("returns false for different lengths without throwing", () => {
    expect(apiKeyMatches("short", "a-much-longer-key")).toBe(false);
  });
});

// The interceptor is mounted on a bare grpc-js server, without Nest, so these
// assertions isolate it from the microservice wiring that
// tests/grpc/users-grpc.test.ts exercises.
describe("makeApiKeyInterceptor on a live grpc-js server", () => {
  const handlerSeenTraceId = vi.fn<(traceId: string | undefined) => void>();
  const handler = vi.fn(
    async (
      _call: grpc.ServerUnaryCall<{ id: string }, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ) => {
      // Read the context on a LATER tick: an activation that only covers a
      // synchronous callback has unwound by now.
      await new Promise((r) => setImmediate(r));
      handlerSeenTraceId(trace.getSpanContext(context.active())?.traceId);
      callback(null, { id: "usr_1", email: "a@b.c", full_name: "Ada", cognito_sub: "" });
    },
  );

  let server: grpc.Server;
  let client: grpc.Client & Record<string, CallableFunction>;

  beforeAll(async () => {
    const pkg = grpc.loadPackageDefinition(
      protoLoader.loadSync(PROTO, { keepCase: true, longs: String, defaults: true, oneofs: true }),
    ) as unknown as { users: { v1: { Users: grpc.ServiceClientConstructor } } };

    server = new grpc.Server({ interceptors: [makeApiKeyInterceptor(API_KEY)] });
    server.addService(pkg.users.v1.Users.service, { GetUserById: handler });
    const port = await new Promise<number>((res, rej) =>
      server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, bound) =>
        err ? rej(err) : res(bound),
      ),
    );
    client = new pkg.users.v1.Users(
      `127.0.0.1:${port}`,
      grpc.credentials.createInsecure(),
    ) as grpc.Client & Record<string, CallableFunction>;
  });

  afterAll(() => {
    client.close();
    server.forceShutdown();
  });

  beforeEach(() => {
    handler.mockClear();
    handlerSeenTraceId.mockClear();
  });

  function call(metadata: grpc.Metadata): Promise<unknown> {
    return new Promise((res, rej) =>
      client.GetUserById({ id: "usr_1" }, metadata, (err: unknown, reply: unknown) =>
        err ? rej(err) : res(reply),
      ),
    );
  }

  function withKey(key?: string): grpc.Metadata {
    const md = new grpc.Metadata();
    if (key !== undefined) md.set("x-api-key", key);
    return md;
  }

  it("rejects a call with no x-api-key as UNAUTHENTICATED without running the handler", async () => {
    await expect(call(withKey())).rejects.toMatchObject({
      code: grpc.status.UNAUTHENTICATED,
      details: "invalid api key",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a wrong x-api-key as UNAUTHENTICATED without running the handler", async () => {
    await expect(call(withKey("wrong-key"))).rejects.toMatchObject({
      code: grpc.status.UNAUTHENTICATED,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("stops a rejected call at the gate, before any trace-context extraction", async () => {
    // grpc-js already drops a call after sendStatus, so the handler spy alone
    // cannot see an interceptor that forwards the metadata anyway.
    const extract = vi.spyOn(propagation, "extract");
    const md = withKey("wrong-key");
    md.set("traceparent", TRACEPARENT);

    await expect(call(md)).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });

    expect(extract).not.toHaveBeenCalled();
    extract.mockRestore();
  });

  it("dispatches to the handler when x-api-key matches", async () => {
    await expect(call(withKey(API_KEY))).resolves.toMatchObject({ id: "usr_1" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("keeps the caller's trace context active inside the async handler", async () => {
    // CONTRACT: The JE-77 gate at the interceptor level — the extracted context
    // must survive to the async handler, or the server span is a ROOT.
    // See [[grpc-context-activate-at-dispatch]]
    const md = withKey(API_KEY);
    md.set("traceparent", TRACEPARENT);

    await call(md);

    expect(handlerSeenTraceId).toHaveBeenCalledWith(INBOUND_TRACE_ID);
  });

  it("does not fabricate a parent when no traceparent arrives", async () => {
    await call(withKey(API_KEY));

    expect(handlerSeenTraceId).toHaveBeenCalledWith(undefined);
  });
});
