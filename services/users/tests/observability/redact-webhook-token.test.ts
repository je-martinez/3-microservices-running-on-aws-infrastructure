import { describe, expect, it } from "vitest";
import pino, { symbols } from "pino";
import Fastify from "fastify";
import type { IncomingMessage } from "node:http";
import {
  redactFastifyRequestSpan,
  redactIncomingSpanAttributes,
  redactWebhookToken,
} from "#shared/observability/redact-webhook-token";
import { buildLoggerOptions } from "#shared/logging/logger";

const TOKEN = "tok_secret_0123456789abcdef0123456789";

describe("redactWebhookToken", () => {
  it("replaces the token segment of the webhook path", () => {
    expect(redactWebhookToken(`/v1/users/stripe/webhook/${TOKEN}`)).toBe(
      "/v1/users/stripe/webhook/[REDACTED]",
    );
  });

  it("keeps a query string while redacting the segment", () => {
    expect(redactWebhookToken(`/v1/users/stripe/webhook/${TOKEN}?a=1`)).toBe(
      "/v1/users/stripe/webhook/[REDACTED]?a=1",
    );
  });

  it("redacts a percent-encoded variant that Fastify routes to the same handler", () => {
    expect(redactWebhookToken(`/v1/users/%73tripe/webhook/${TOKEN}`)).toBe(
      "/v1/users/stripe/webhook/[REDACTED]",
    );
  });

  it("leaves every other path untouched", () => {
    expect(redactWebhookToken("/v1/users/me")).toBe("/v1/users/me");
    expect(redactWebhookToken("/v1/users/stripe/webhook")).toBe("/v1/users/stripe/webhook");
  });
});

function fakeIncoming(url: string): IncomingMessage {
  return { url, headers: { host: "users:3000" } } as unknown as IncomingMessage;
}

describe("span redaction hooks", () => {
  it("overrides every URL attribute of the HTTP server span for the webhook path", () => {
    const attrs = redactIncomingSpanAttributes(fakeIncoming(`/v1/users/stripe/webhook/${TOKEN}`));
    expect(attrs).toEqual({
      "http.target": "/v1/users/stripe/webhook/[REDACTED]",
      "http.url": "http://users:3000/v1/users/stripe/webhook/[REDACTED]",
      "url.path": "/v1/users/stripe/webhook/[REDACTED]",
    });
    expect(JSON.stringify(attrs)).not.toContain(TOKEN);
  });

  it("adds nothing for any other path", () => {
    expect(redactIncomingSpanAttributes(fakeIncoming("/v1/users/me"))).toEqual({});
  });

  it("rewrites url.path on the @fastify/otel request span", () => {
    const set: Record<string, unknown> = {};
    const span = { setAttribute: (k: string, v: unknown) => ((set[k] = v), span) };
    redactFastifyRequestSpan(span as never, { url: `/v1/users/stripe/webhook/${TOKEN}` } as never);
    expect(set).toEqual({ "url.path": "/v1/users/stripe/webhook/[REDACTED]" });
  });
});

describe("Fastify logger `req` serializer", () => {
  it("never writes the token when Fastify serializes the request", async () => {
    const lines: string[] = [];
    const app = Fastify({ logger: buildLoggerOptions({ serviceName: "users", environment: "test" }) });
    (app.log as unknown as Record<symbol, unknown>)[symbols.streamSym] = {
      write: (s: string) => lines.push(s),
    };
    app.post("/v1/users/stripe/webhook/:token", async (request) => {
      request.log.info({ req: request }, "serialized");
      return { ok: true };
    });

    await app.inject({ method: "POST", url: `/v1/users/stripe/webhook/${TOKEN}` });
    await app.close();

    const serialized = lines.find((l) => l.includes("serialized"));
    expect(serialized).toBeDefined();
    expect(JSON.parse(serialized!).req.url).toBe("/v1/users/stripe/webhook/[REDACTED]");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("keeps the plain URL for every other route", async () => {
    const lines: string[] = [];
    const logger = pino(buildLoggerOptions({ serviceName: "users", environment: "test" }), {
      write: (s: string) => lines.push(s),
    });
    const app = Fastify({ loggerInstance: logger });
    app.get("/v1/users/me", async (request) => {
      request.log.info({ req: request }, "serialized");
      return {};
    });

    await app.inject({ method: "GET", url: "/v1/users/me" });
    await app.close();

    expect(JSON.parse(lines.find((l) => l.includes("serialized"))!).req.url).toBe("/v1/users/me");
  });
});
