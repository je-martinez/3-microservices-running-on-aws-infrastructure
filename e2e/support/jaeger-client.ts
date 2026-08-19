// Minimal Jaeger query-API read client for the distributed-tracing specs.
//
// Scope is deliberately narrow: reachability, and "find the one trace that
// carries this tag". Nothing here writes, and nothing here asserts — the
// assertions and their failure messages live in the spec, because what counts
// as a complete trace is a property of the flow under test, not of Jaeger.
//
// Endpoint: Jaeger all-in-one's query UI/API on :16686 (see
// observability/docker-compose.observability.yml). Overridable so a
// differently-provisioned stack still works.
//
// ## Why a POLL, not a sleep
//
// Spans do not reach Jaeger when they end. They sit in each service's
// BatchSpanProcessor (default schedule 5s), then in the collector's own `batch`
// processor, before export. A single sleep sized to "about the export interval"
// is exactly the measurement window this repo has already been burned by twice
// (docs/lessons — a 60s window inside a 60s export cycle read as a PASS). So
// `findTraceByTag` polls across SEVERAL multiples of that interval and returns
// as soon as the trace is complete enough, rather than betting on one guess.

const DEFAULT_BASE_URL = "http://localhost:16686";

export const jaegerBaseURL = process.env.JAEGER_URL ?? DEFAULT_BASE_URL;

/** A span as Jaeger's query API returns it — only the fields these specs read. */
export type JaegerSpan = {
  spanID: string;
  operationName: string;
  processID: string;
  /** Parent/link edges. EMPTY means this span is a trace root — the JE-77 signal. */
  references: Array<{ refType: string; traceID: string; spanID: string }>;
  tags: Array<{ key: string; type: string; value: unknown }>;
};

export type JaegerTrace = {
  traceID: string;
  spans: JaegerSpan[];
  processes: Record<string, { serviceName: string }>;
};

/** A span paired with the service that emitted it — `processID` alone is meaningless outside its trace. */
export type AttributedSpan = JaegerSpan & { serviceName: string };

/** True when Jaeger answers at all. Used to skip with a reason rather than fail obscurely. */
export async function isJaegerReachable(timeoutMs = 5_000): Promise<boolean> {
  try {
    const res = await fetch(`${jaegerBaseURL}/api/services`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Flattens a trace into spans that each know their own service name. */
export function attributeSpans(trace: JaegerTrace): AttributedSpan[] {
  return trace.spans.map((span) => ({
    ...span,
    serviceName: trace.processes[span.processID]?.serviceName ?? "(unknown process)",
  }));
}

/** Reads a string-valued tag off a span, or `undefined` when absent. */
export function tagValue(span: JaegerSpan, key: string): string | undefined {
  const tag = span.tags.find((t) => t.key === key);
  return tag === undefined ? undefined : String(tag.value);
}

/**
 * Fetches recent traces for a service, newest first.
 *
 * `operation` is INTENTIONALLY optional and left unset by the callers here.
 * Jaeger filters by operation name with an exact string match, so pinning one
 * couples the spec to a span name it does not own — the kind of tight coupling
 * that turns a harmless rename into a red test that says nothing useful. The
 * caller filters by TAG instead, which is a value the flow itself produced.
 */
export async function fetchTraces(
  service: string,
  { lookback = "15m", limit = 40, operation }: { lookback?: string; limit?: number; operation?: string } = {},
): Promise<JaegerTrace[]> {
  const params = new URLSearchParams({ service, lookback, limit: String(limit) });
  if (operation) params.set("operation", operation);

  const res = await fetch(`${jaegerBaseURL}/api/traces?${params.toString()}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Jaeger trace query failed for service "${service}": ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: JaegerTrace[]; errors?: unknown };
  return body.data ?? [];
}

export type FindTraceOptions = {
  /** Total time to keep polling. Several multiples of the 5s BatchSpanProcessor schedule. */
  timeoutMs?: number;
  /** Gap between polls. Short enough that a fast export is not needlessly waited out. */
  intervalMs?: number;
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
  trace: JaegerTrace | undefined;
  spans: AttributedSpan[];
  /** Whether `isComplete` was satisfied. False with a defined `trace` means "found, still partial". */
  complete: boolean;
  /** How many polls ran — quoted in failure messages so a timeout is distinguishable from a bad query. */
  attempts: number;
};

/**
 * Polls Jaeger until a trace of `service` carries `tagKey=tagValue` AND
 * satisfies `isComplete`, or the timeout expires.
 *
 * Never throws on "not found" — it returns what it saw. Deciding that an
 * absent or partial trace is a failure, and saying WHICH spans did arrive, is
 * the spec's job: a count alone ("2 of 3 services") cannot tell a broken
 * cascade from a wrong expectation.
 */
export async function findTraceByTag(
  service: string,
  tagKey: string,
  expectedValue: string,
  { timeoutMs = 60_000, intervalMs = 2_000, isComplete = () => true }: FindTraceOptions = {},
): Promise<FindTraceResult> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let best: { trace: JaegerTrace; spans: AttributedSpan[] } | undefined;

  while (Date.now() < deadline) {
    attempts += 1;
    const traces = await fetchTraces(service, { lookback: "30m", limit: 40 });

    for (const trace of traces) {
      if (!trace.spans.some((span) => tagValue(span, tagKey) === expectedValue)) continue;

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
    names.push(span.operationName);
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
