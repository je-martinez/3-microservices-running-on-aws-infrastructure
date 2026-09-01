// WHY: Poll _search — single sleep sized to export interval yields false PASS.
// span_kind is OTLP numeric ("2"=SERVER). UI waterfall needs observability-traces-schema.
// See [[ADR-0019-distributed-tracing-opentelemetry]]

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
 * OTLP SpanKind as OpenObserve stores it — numeric string ("2" = SERVER).
 * Do NOT compare against the string "server" — matches nothing.
 */
export const SpanKind = {
  INTERNAL: "1",
  SERVER: "2",
  CLIENT: "3",
  PRODUCER: "4",
  CONSUMER: "5",
} as const;

export type SpanKindValue = (typeof SpanKind)[keyof typeof SpanKind];

/** OpenObserve _search row; attributes flatten to top-level columns. */
export type TraceSpan = {
  trace_id: string;
  span_id: string;
  operation_name: string;
  service_name: string;
  span_kind?: string;
  /**
   * Parent edge. ABSENT (undefined) means trace root — the JE-77 signal.
   * Root spans omit the column entirely; use `=== undefined`, not falsiness.
   */
  reference_parent_span_id?: string;
  [column: string]: unknown;
};

/**
 * Span with serviceName attached — OpenObserve rows already carry service_name.
 */
export type AttributedSpan = TraceSpan & { serviceName: string };

/** A trace, reassembled from the flat rows that share a `trace_id`. */
export type Trace = {
  traceID: string;
  spans: TraceSpan[];
};

/** Skip when OpenObserve is unreachable rather than fail obscurely. */
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

/** OpenObserve omits unset attributes — treat null and missing as undefined. */
export function tagValue(span: TraceSpan, key: string): string | undefined {
  const raw = span[key];
  return raw === undefined || raw === null ? undefined : String(raw);
}

/** Escapes a value for inlining into an OpenObserve SQL string literal. */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

type SearchResponse = { hits?: TraceSpan[] };

/** Query bounds use microseconds; span start_time column is nanoseconds — do not mix. */
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

/** UI link with explicit from/to window (microseconds). */
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

/** Fetch all spans for trace_id after id lookup (filtered query returns one span only). */
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
  /** Keep polling until all expected services export (orders often lands before tracking). */
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

/** Poll until tag match and isComplete; returns partial trace on timeout (spec asserts). */
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
