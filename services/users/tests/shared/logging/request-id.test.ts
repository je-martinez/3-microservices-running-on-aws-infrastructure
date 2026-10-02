import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  REQUEST_ID_HEADER,
  generateRequestId,
  resolveRequestId,
} from "#shared/logging/request-id";
import { getLogContext, type LogContextStore } from "#shared/logging/log-context";

// WHY: The real config module validates the whole env at import time; the middleware
// only reads E2E_TESTING_ENABLED, which a stub answers.
vi.mock("#config/config.module", () => ({ AppConfigService: class {} }));
const { RequestContextMiddleware } = await import("#shared/http/request-context.middleware");

const REQUEST_ID = /^req_[A-Za-z0-9]{24}$/;

describe("resolveRequestId", () => {
  it("honours a valid inbound id", () => {
    const incoming = generateRequestId();
    expect(resolveRequestId(incoming)).toBe(incoming);
  });

  it("generates a well-formed id when the header is absent", () => {
    expect(resolveRequestId(undefined)).toMatch(REQUEST_ID);
  });

  // CONTRACT: The header is untrusted and lands on every log line of the flow —
  // discard anything not shaped like our own id, never reject the request.
  // See [[2026-08-15-request-id-correlation-design]]
  it.each([
    ["empty", ""],
    ["no prefix", "V1StGXR8Z5jdHi6B-myT0"],
    ["wrong prefix", "ord_V1StGXR8Z5jdHi6B-myT"],
    ["too short", "req_abc"],
    ["too long", `req_${"a".repeat(64)}`],
    ["control characters", "req_aaaaaaaaaaaaaaaa\n\raa"],
    ["not a string", 42],
    ["a repeated header", ["req_aaaaaaaaaaaaaaaaaaaaaaaa"]],
  ])("discards an invalid id (%s) and generates a fresh one", (_label, value) => {
    const resolved = resolveRequestId(value as unknown);
    expect(resolved).not.toBe(value);
    expect(resolved).toMatch(REQUEST_ID);
  });

  it("generates a distinct id per call", () => {
    expect(generateRequestId()).not.toBe(generateRequestId());
  });
});

describe("request id at ingress (RequestContextMiddleware)", () => {
  function contextFor(headers: Record<string, string>): LogContextStore {
    const middleware = new RequestContextMiddleware({ get: () => false } as never);
    let seen: LogContextStore = {};
    middleware.use({ headers } as IncomingMessage, {} as ServerResponse, () => {
      seen = { ...getLogContext() };
    });
    return seen;
  }

  it("puts the caller's id on the request's log context", () => {
    const incoming = generateRequestId();
    expect(contextFor({ [REQUEST_ID_HEADER]: incoming }).request_id).toBe(incoming);
  });

  it("generates one when the caller sends none", () => {
    expect(contextFor({}).request_id).toMatch(REQUEST_ID);
  });

  it("does not honour a forged id", () => {
    const forged = "'; DROP TABLE users; --";
    const { request_id } = contextFor({ [REQUEST_ID_HEADER]: forged });
    expect(request_id).not.toBe(forged);
    expect(request_id).toMatch(REQUEST_ID);
  });
});
