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
    // NOT /v1/health: a succeeding liveness probe is exempt from this log (see
    // the health-check-logging convention), so asserting the schema against it
    // would assert the exemption instead. This test used to do exactly that and
    // started failing when the exemption landed — correctly.
    await app.inject({ method: "GET", url: "/v1/no-such-route" });
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

  it("emits exactly ONE line per request", async () => {
    // Fastify's built-in request logging uses the same "request completed"
    // message as our hook, so with it enabled every request produced TWO lines:
    // one carrying `http_route`/`duration_ms` and one carrying `res`/
    // `responseTime`. Every request-rate figure read double, and half the rows
    // answered an `http_route` filter with nothing. `disableRequestLogging`
    // is what makes this assertion hold.
    const lines: string[] = [];
    const app = buildApp(undefined, { logStream: { write: (s: string) => lines.push(s) } });

    await app.inject({ method: "GET", url: "/v1/no-such-route" });

    const completed = lines
      .map((l) => JSON.parse(l))
      .filter((r) => r.message === "request completed");
    expect(completed).toHaveLength(1);

    await app.close();
  });

  it("does not log a SUCCEEDING liveness probe", async () => {
    // The probe runs forever at a fixed interval, so its successes are volume
    // that scales with uptime rather than usage — 96% of one service's stream
    // when this was measured. A healthy container already says what a 200 here
    // would say.
    const lines: string[] = [];
    const app = buildApp(undefined, { logStream: { write: (s: string) => lines.push(s) } });

    const response = await app.inject({ method: "GET", url: "/v1/health" });
    expect(response.statusCode).toBe(200);

    const completed = lines
      .map((l) => JSON.parse(l))
      .filter((r) => r.message === "request completed");
    expect(completed).toHaveLength(0);

    await app.close();
  });
});
