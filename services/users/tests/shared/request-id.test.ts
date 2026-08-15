import { describe, it, expect } from "vitest";
import { buildApp } from "#features/users/http/routes";
import {
  REQUEST_ID_HEADER,
  generateRequestId,
  resolveRequestId,
} from "#shared/logging/request-id";

// `request_id` correlates one logical request across every service and every
// hop. Unlike `trace_id` it needs no OTel SDK, which is why it exists: the
// events-pipeline and the realtime Lambdas run none. See
// docs/superpowers/specs/2026-08-15-request-id-correlation-design.md.
describe("request-id", () => {
  describe("resolveRequestId", () => {
    it("honours a valid inbound id", () => {
      const incoming = generateRequestId();
      expect(resolveRequestId(incoming)).toBe(incoming);
    });

    it("generates a well-formed id when the header is absent", () => {
      expect(resolveRequestId(undefined)).toMatch(/^req_[A-Za-z0-9_-]{21}$/);
    });

    it.each([
      ["empty", ""],
      ["no prefix", "V1StGXR8Z5jdHi6B-myT0"],
      ["wrong prefix", "ord_V1StGXR8Z5jdHi6B-myT"],
      ["too short", "req_abc"],
      ["too long", `req_${"a".repeat(64)}`],
      ["control characters", "req_aaaaaaaaaaaaaaaa\n\raa"],
      ["not a string", 42],
    ])("discards an invalid id (%s) and generates a fresh one", (_label, value) => {
      const resolved = resolveRequestId(value as unknown);
      expect(resolved).not.toBe(value);
      expect(resolved).toMatch(/^req_[A-Za-z0-9_-]{21}$/);
    });
  });

  describe("the request context", () => {
    it("puts the caller's id on the request log", async () => {
      const lines: string[] = [];
      const app = buildApp(undefined, { logStream: { write: (s: string) => lines.push(s) } });
      const incoming = generateRequestId();

      // A REAL route: on a 404 Fastify answers from the router without running
      // the route-level onRequest hook, so the context is never seeded and this
      // would assert nothing. Not /v1/health either — a succeeding probe is
      // exempt from the request log.
      await app.inject({
        method: "GET",
        url: "/v1/users/me",
        headers: { [REQUEST_ID_HEADER]: incoming },
      });

      const reqLog = lines.map((l) => JSON.parse(l)).find((r) => r.http_route);
      expect(reqLog.request_id).toBe(incoming);

      await app.close();
    });

    it("generates one when the caller sends none", async () => {
      const lines: string[] = [];
      const app = buildApp(undefined, { logStream: { write: (s: string) => lines.push(s) } });

      await app.inject({ method: "GET", url: "/v1/users/me" });

      const reqLog = lines.map((l) => JSON.parse(l)).find((r) => r.http_route);
      expect(reqLog.request_id).toMatch(/^req_[A-Za-z0-9_-]{21}$/);

      await app.close();
    });

    it("does not honour a forged id", async () => {
      // The header is untrusted input that lands on every line of the flow.
      const lines: string[] = [];
      const app = buildApp(undefined, { logStream: { write: (s: string) => lines.push(s) } });

      await app.inject({
        method: "GET",
        url: "/v1/users/me",
        headers: { [REQUEST_ID_HEADER]: "'; DROP TABLE users; --" },
      });

      const reqLog = lines.map((l) => JSON.parse(l)).find((r) => r.http_route);
      expect(reqLog.request_id).toMatch(/^req_[A-Za-z0-9_-]{21}$/);

      await app.close();
    });
  });
});
