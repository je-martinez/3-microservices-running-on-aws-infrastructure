import "reflect-metadata";

// CONTRACT: Seed env BEFORE importing main.ts — it parses process.env at import
// time. Boots the REAL createNestApp() so the assertions cover the adapter
// wiring, not a bespoke Fastify instance.
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
});

const { afterAll, beforeAll, describe, expect, it } = await import("vitest");
const net = await import("node:net");
type NestFastifyApplication = import("@nestjs/platform-fastify").NestFastifyApplication;
const { createNestApp } = await import("../../src/main.ts");

// Raw bytes on a socket: an HTTP client would normalise the framing under test.
function rawRequest(port: number, head: string[], body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write([...head, "Host: localhost", "Connection: close", "", body].join("\r\n"));
    });
    let response = "";
    socket.on("data", (chunk) => (response += chunk.toString()));
    socket.on("error", reject);
    socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1])));
  });
}

describe("bodyless requests through the real createNestApp()", () => {
  let app: NestFastifyApplication;
  let port: number;

  beforeAll(async () => {
    app = await createNestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.getHttpServer().address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  afterAll(async () => {
    await app.close();
  });

  // DELETE /v1/users/me with no x-user-id answers 401 from the guard, so a 401
  // proves the request got past body parsing and reached the route.
  it("treats a zero-length chunked body with no Content-Type as no body", async () => {
    const status = await rawRequest(
      port,
      ["DELETE /v1/users/me HTTP/1.1", "Transfer-Encoding: chunked"],
      "0\r\n\r\n",
    );
    expect(status).toBe(401);
  });

  it("treats Content-Length: 0 with no Content-Type as no body", async () => {
    const status = await rawRequest(port, ["DELETE /v1/users/me HTTP/1.1", "Content-Length: 0"], "");
    expect(status).toBe(401);
  });

  it("still answers 415 to a non-empty chunked body with no Content-Type", async () => {
    const status = await rawRequest(
      port,
      ["DELETE /v1/users/me HTTP/1.1", "Transfer-Encoding: chunked"],
      "2\r\n{}\r\n0\r\n\r\n",
    );
    expect(status).toBe(415);
  });

  it("still answers 415 to a non-empty body with no Content-Type", async () => {
    const status = await rawRequest(port, ["DELETE /v1/users/me HTTP/1.1", "Content-Length: 2"], "{}");
    expect(status).toBe(415);
  });

  it("still answers 415 to an unknown Content-Type, even with an empty body", async () => {
    const status = await rawRequest(
      port,
      ["DELETE /v1/users/me HTTP/1.1", "Content-Type: text/xml", "Transfer-Encoding: chunked"],
      "0\r\n\r\n",
    );
    expect(status).toBe(415);
  });

  it("parses JSON bodies as before", async () => {
    const status = await rawRequest(
      port,
      ["DELETE /v1/users/me HTTP/1.1", "Content-Type: application/json", "Content-Length: 2"],
      "{}",
    );
    expect(status).toBe(401);
  });
});
