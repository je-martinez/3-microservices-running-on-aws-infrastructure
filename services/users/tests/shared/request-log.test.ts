import { describe, it, expect } from "vitest";
import { buildApp } from "#features/users/http/routes";

describe("request logging", () => {
  it("emits a schema request log on each response", async () => {
    const lines: string[] = [];
    // NOTE: `buildApp`'s first positional param is the Awilix container
    // (defaults to the shared `diContainer`); this task adds a second,
    // optional `opts.logStream` param for testability rather than replacing
    // the existing signature (see task-4-report.md for the deviation from
    // the brief's single-arg example).
    const app = buildApp(undefined, { logStream: { write: (s: string) => lines.push(s) } });
    await app.inject({ method: "GET", url: "/v1/health" });
    const reqLog = lines.map((l) => JSON.parse(l)).find((r) => r.http_route);
    expect(reqLog).toBeDefined();
    expect(reqLog.http_request_method).toBe("GET");
    expect(reqLog.http_response_status_code).toBeDefined();
    expect(typeof reqLog.duration_ms).toBe("number");

    // `trace_id` is deliberately NOT asserted here any more. It used to be
    // Fastify's local `req.id`, which this service stopped emitting: Pino now
    // injects the REAL OTel trace_id/span_id whenever a span is active, and
    // that is the id that joins a log line to its trace. No OTel SDK runs in
    // the unit-test process, so there is no active span and the field is
    // correctly absent. Its presence in a running service is verified end to
    // end against the live stack instead (JE-75/JE-77).
    expect(reqLog.trace_id).toBeUndefined();

    await app.close();
  });

});
