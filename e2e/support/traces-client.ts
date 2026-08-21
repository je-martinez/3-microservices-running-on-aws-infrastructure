// Minimal OpenObserve trace read client for the distributed-tracing specs.
//
// Scope is deliberately narrow: reachability, and "find the one trace that
// carries this attribute". Nothing here writes, and nothing here asserts — the
// assertions and their failure messages live in the spec, because what counts
// as a complete trace is a property of the flow under test, not of the trace
// backend.
//
// Endpoint: OpenObserve's `_search` API on :5080 (see
// observability/docker-compose.yml, `make observability-up`). Base URL and
// credentials are overridable so a differently-provisioned stack still works.
//
// Replaces the previous Jaeger client (:16686), removed from this repo on
// 2026-08-21 — OpenObserve is now the only trace backend.
//
// ## Why a POLL, not a sleep
//
// Spans do not reach the backend when they end. They sit in each service's
// BatchSpanProcessor (default schedule 5s), then in the collector's own `batch`
// processor, before export. A single sleep sized to "about the export interval"
// is exactly the measurement window this repo has already been burned by twice
// (docs/lessons — a 60s window inside a 60s export cycle read as a PASS). So
// `findTraceByTag` polls across SEVERAL multiples of that interval and returns
// as soon as the trace is complete enough, rather than betting on one guess.
//
// ## Shape: FLAT rows, not a nested trace
//
// Jaeger returned a nested trace with a `processes` map that had to be joined
// back to each span to recover its service name. OpenObserve returns flat span
// rows that already carry `service_name`, and span ATTRIBUTES flattened to
// top-level snake_case columns (`order_id`, `app_event`, `rpc_system`, …), so
// the tag filter is a plain SQL predicate. Verified against the live
// `app_traces` schema rather than assumed — an attribute that no span carries
// is not a column at all, and an absent attribute is OMITTED from the row
// rather than returned as null, which is why `tagValue` treats missing and
// empty identically.
//
// ## Debugging a failure in the UI
//
// The `_search` API this client uses is healthy, but OpenObserve's trace
// WATERFALL is not built from it — the UI calls its own
// `/api/{org}/{stream}/traces/{id}/dag`, which 400s until the stream has the
// `gen_ai_operation_name` column its LLM-tracing feature expects. Run
// `make observability-traces-schema` once, or every `viewTraceURL` link below
// opens on an error. See [[ADR-0019-distributed-tracing-opentelemetry]] and
// docs/lessons/2026-08-21-verify-in-the-viewer-not-the-api.md.

const DEFAULT_BASE_URL = "http://localhost:5080";
const DEFAULT_ORG = "3mrai";
const DEFAULT_STREAM = "app_traces";
const DEFAULT_USER = "admin@3mrai.local";
const DEFAULT_PASSWORD = "Complexpass#123";

export const tracesBaseURL = process.env.OPENOBSERVE_URL ?? DEFAULT_BASE_URL;
export const tracesOrg = process.env.OPENOBSERVE_ORG ?? DEFAULT_ORG;
export const tracesStream = process.env.OPENOBSERVE_TRACES_STREAM ?? DEFAULT_STREAM;

const tracesUser = process.env.OPENOBSERVE_USER ?? DEFAULT_USER;
const tracesPassword = process.env.OPENOBSERVE_PASSWORD ?? DEFAULT_PASSWORD;

const authHeader = `Basic ${Buffer.from(`${tracesUser}:${tracesPassword}`).toString("base64")}`;

/**
 * OTLP `SpanKind` as OpenObserve stores it: the NUMERIC enum, as a string.
 *
 * This is the one place the migration is not a rename. Jaeger exposed a
 * `span.kind` tag valued `"server"`/`"client"`; OpenObserve keeps the raw OTLP
 * ordinal in `span_kind` (`"2"` for SERVER — confirmed against live rows). A
 * spec comparing against `"server"` would therefore match NOTHING and read as
 * "the span is missing", which is indistinguishable from the very regression
 * the JE-77 assertion exists to catch. Naming the values keeps that trap out of
 * the spec.
 */
export const SpanKind = {
  INTERNAL: "1",
  SERVER: "2",
  CLIENT: "3",
  PRODUCER: "4",
  CONSUMER: "5",
} as const;

export type SpanKindValue = (typeof SpanKind)[keyof typeof SpanKind];

/**
 * A span row as OpenObserve's `_search` returns it.
 *
 * Indexed rather than closed: attributes are flattened to arbitrary top-level
 * columns, and which ones exist depends on what the services emit. The named
 * fields are the ones these specs read; `tagValue` reaches the rest.
 */
export type TraceSpan = {
  trace_id: string;
  span_id: string;
  operation_name: string;
  service_name: string;
  span_kind?: string;
  /**
   * Parent edge. ABSENT (undefined) means this span is a trace root — the JE-77
   * signal, and the direct equivalent of Jaeger's empty `references: []`.
   * Verified: root spans omit the column entirely rather than sending "" or
   * null, so `=== undefined` is the check, not a falsiness test that would also
   * swallow a legitimately empty value.
   */
  reference_parent_span_id?: string;
  [column: string]: unknown;
};

/**
 * A span already carrying its service name.
 *
 * With Jaeger this was a real join (`processID` → `processes[…]`). OpenObserve
 * rows already carry `service_name`, so the type is an alias — kept as a
 * distinct name so the spec's signatures and the helpers below read unchanged.
 */
export type AttributedSpan = TraceSpan & { serviceName: string };

/** A trace, reassembled from the flat rows that share a `trace_id`. */
export type Trace = {
  traceID: string;
  spans: TraceSpan[];
};

/** True when OpenObserve answers at all. Used to skip with a reason rather than fail obscurely. */
export async function isTraceBackendReachable(timeoutMs = 5_000): Promise<boolean> {
  try {
    const res = await fetch(`${tracesBaseURL}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Attaches `serviceName` to each row, so callers read one name regardless of backend. */
export function attributeSpans(trace: Trace): AttributedSpan[] {
  return trace.spans.map((span) => ({
    ...span,
    serviceName: span.service_name ?? "(unknown service)",
  }));
}

/**
 * Reads a flattened span attribute, or `undefined` when absent.
 *
 * OpenObserve omits a column from a row when the span did not set it, so
 * "missing" and "null" arrive identically — both must yield `undefined` so a
 * caller's `=== expected` cannot accidentally match the string "null".
 */
export function tagValue(span: TraceSpan, key: string): string | undefined {
  const raw = span[key];
  return raw === undefined || raw === null ? undefined : String(raw);
}

/** Escapes a value for inlining into an OpenObserve SQL string literal. */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

type SearchResponse = { hits?: TraceSpan[] };

/**
 * Runs one SQL query against the traces stream over a `lookbackMs` window.
 *
 * `start_time`/`end_time` are MICROSECONDS since epoch — note this differs from
 * the `start_time` COLUMN on a span row, which is nanoseconds. Mixing the two
 * silently returns an empty result set (a window ~1000× too narrow or too
 * wide), which reads as "the trace never arrived".
 */
async function search(sql: string, { lookbackMs = 30 * 60_000, size = 200 } = {}): Promise<TraceSpan[]> {
  const endMicros = Date.now() * 1_000;
  const startMicros = endMicros - lookbackMs * 1_000;

  const res = await fetch(`${tracesBaseURL}/api/${tracesOrg}/_search?type=traces`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({
      query: { sql, start_time: startMicros, end_time: endMicros, from: 0, size },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`OpenObserve trace query failed: ${res.status} ${await res.text()}\nSQL: ${sql}`);
  }
  const body = (await res.json()) as SearchResponse;
  return body.hits ?? [];
}

/**
 * A deep link to the trace in OpenObserve's UI, for failure messages.
 *
 * The route needs an explicit time window (`from`/`to`, microseconds) or it
 * opens on the default range and shows nothing. Widened generously around now
 * rather than fitted to the trace: the link is read minutes after the run.
 */
export function viewTraceURL(traceID: string, windowMs = 60 * 60_000): string {
  const to = Date.now() * 1_000;
  const from = to - windowMs * 1_000;
  const params = new URLSearchParams({
    stream: tracesStream,
    org_identifier: tracesOrg,
    trace_id: traceID,
    from: String(from),
    to: String(to),
  });
  return `${tracesBaseURL}/web/traces/trace-details?${params.toString()}`;
}

/**
 * Fetches every span of one trace.
 *
 * Separate from the id lookup on purpose. The attribute that identifies a trace
 * (`order_id`) is set on ONE span, so a single filtered query returns that span
 * alone and would make every trace look like it had one service. Finding the id
 * and then reading the whole trace is what keeps the completeness check honest.
 */
export async function fetchTrace(traceID: string, lookbackMs?: number): Promise<Trace> {
  const spans = await search(
    `SELECT * FROM ${tracesStream} WHERE trace_id = ${sqlLiteral(traceID)} ORDER BY start_time ASC`,
    { lookbackMs, size: 500 },
  );
  return { traceID, spans };
}

export type FindTraceOptions = {
  /** Total time to keep polling. Several multiples of the 5s BatchSpanProcessor schedule. */
  timeoutMs?: number;
  /** Gap between polls. Short enough that a fast export is not needlessly waited out. */
  intervalMs?: number;
  /** How far back to search. Generous — the cost of a wide window is a slower query, not a wrong answer. */
  lookbackMs?: number;
  /**
   * Optional extra condition on the matched trace. A trace can be FOUND before
   * it is COMPLETE: the services export independently, so the `orders` spans
   * commonly land a batch ahead of `tracking`'s. Returning early on the first
   * match would then assert against a half-arrived trace and report a missing
   * service that is merely late — a false FAIL that looks exactly like a real
   * propagation break. This predicate is how a caller says "keep polling until
   * the parts I care about are actually here".
   */
  isComplete?: (spans: AttributedSpan[]) => boolean;
};

export type FindTraceResult = {
  /** The best trace seen — the complete one if it arrived, otherwise the last partial match. */
  trace: Trace | undefined;
  spans: AttributedSpan[];
  /** Whether `isComplete` was satisfied. False with a defined `trace` means "found, still partial". */
  complete: boolean;
  /** How many polls ran — quoted in failure messages so a timeout is distinguishable from a bad query. */
  attempts: number;
};

/**
 * Polls OpenObserve until a trace of `service` carries `tagKey=expectedValue`
 * AND satisfies `isComplete`, or the timeout expires.
 *
 * `service` scopes the id lookup to the service that OWNS the identifying
 * attribute, not the set of services expected in the result — the trace is then
 * read whole. Matching on a value the flow itself produced (rather than on a
 * span NAME) is deliberate: it cannot collide with another run's trace, and it
 * survives a span rename, so an instrumentation upgrade does not read as a
 * propagation break.
 *
 * Never throws on "not found" — it returns what it saw. Deciding that an absent
 * or partial trace is a failure, and saying WHICH spans did arrive, is the
 * spec's job: a count alone ("2 of 3 services") cannot tell a broken cascade
 * from a wrong expectation.
 */
export async function findTraceByTag(
  service: string,
  tagKey: string,
  expectedValue: string,
  {
    timeoutMs = 60_000,
    intervalMs = 2_000,
    lookbackMs = 30 * 60_000,
    isComplete = () => true,
  }: FindTraceOptions = {},
): Promise<FindTraceResult> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let best: { trace: Trace; spans: AttributedSpan[] } | undefined;

  const idQuery =
    `SELECT trace_id FROM ${tracesStream} ` +
    `WHERE service_name = ${sqlLiteral(service)} AND ${tagKey} = ${sqlLiteral(expectedValue)} ` +
    `ORDER BY start_time DESC`;

  while (Date.now() < deadline) {
    attempts += 1;

    const matches = await search(idQuery, { lookbackMs, size: 20 });
    const traceIDs = [...new Set(matches.map((row) => row.trace_id).filter(Boolean))];

    for (const traceID of traceIDs) {
      const trace = await fetchTrace(traceID, lookbackMs);
      const spans = attributeSpans(trace);

      // Keep the richest partial seen, so a timeout still reports real spans
      // rather than "nothing found" when the trace was simply still arriving.
      if (best === undefined || spans.length > best.spans.length) best = { trace, spans };
      if (isComplete(spans)) {
        return { trace, spans, complete: true, attempts };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return { trace: best?.trace, spans: best?.spans ?? [], complete: false, attempts };
}

/** `service → [operation names]`, for failure messages that show WHAT arrived instead of a count. */
export function describeSpans(spans: AttributedSpan[]): string {
  const byService = new Map<string, string[]>();
  for (const span of spans) {
    const names = byService.get(span.serviceName) ?? [];
    names.push(span.operation_name);
    byService.set(span.serviceName, names);
  }
  if (byService.size === 0) return "  (no spans at all)";
  return [...byService.entries()]
    .map(([service, names]) => {
      const counted = [...new Set(names)]
        .sort()
        .map((name) => {
          const n = names.filter((other) => other === name).length;
          return n > 1 ? `${name} ×${n}` : name;
        })
        .join(", ");
      return `  ${service} (${names.length}): ${counted}`;
    })
    .join("\n");
}
