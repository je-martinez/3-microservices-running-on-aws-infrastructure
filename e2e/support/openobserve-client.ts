// Minimal OpenObserve read client for the dashboard-contract specs: reachability and
// stream schemas only. Nothing writes, and nothing queries panel data — see
// tests/observability/dashboards.spec.ts for why asserting on ROWS is the wrong
// contract for a dashboard. The default credential is the local stack's fixed admin
// account (docker-compose.observability.yml), not a secret, and is overridable.

const DEFAULT_BASE_URL = "http://localhost:5080";
const DEFAULT_ORG = "3mrai";
const DEFAULT_AUTH = "Basic YWRtaW5AM21yYWkubG9jYWw6Q29tcGxleHBhc3MjMTIz";

export const openobserveBaseURL = process.env.OPENOBSERVE_URL ?? DEFAULT_BASE_URL;
const org = process.env.OPENOBSERVE_ORG ?? DEFAULT_ORG;
const authHeader = process.env.OPENOBSERVE_AUTH ?? DEFAULT_AUTH;

// CONTRACT: Always send the stream `type`. OpenObserve treats it as part of a
// stream's IDENTITY, not a filter, so an omitted or wrong type answers 404 — not an
// empty schema — and every metrics panel then looks like a broken dashboard.
export type StreamType = "logs" | "metrics" | "traces";

export type StreamSchema = {
  /** Field names exactly as OpenObserve inferred them. */
  fields: Set<string>;
  /** Documents ingested, from the stream's own stats — used to tell "no data" from "wrong field". */
  docCount: number;
};

/** True when the observability stack answers at all. Used to skip with a reason rather than fail. */
export async function isOpenObserveReachable(timeoutMs = 5_000): Promise<boolean> {
  try {
    const res = await fetch(`${openobserveBaseURL}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fetches a stream's inferred schema. Returns `null` when the stream does not
 * exist at all (404) — a distinct condition from "exists but has few fields",
 * and the two get different failure messages at the call site.
 */
export async function fetchStreamSchema(
  stream: string,
  type: StreamType,
): Promise<StreamSchema | null> {
  const url = `${openobserveBaseURL}/api/${org}/streams/${encodeURIComponent(stream)}/schema?type=${type}`;
  const res = await fetch(url, { headers: { Authorization: authHeader } });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`OpenObserve schema fetch failed for ${type} stream "${stream}": ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as {
    code?: number;
    schema?: Array<{ name: string; type: string }>;
    stats?: { doc_num?: number };
  };

  // A 200 carrying a 404 code: OpenObserve answers this way for some
  // stream/type combinations rather than setting the HTTP status.
  if (body.code === 404 || !body.schema) return null;

  return {
    fields: new Set(body.schema.map((f) => f.name)),
    docCount: body.stats?.doc_num ?? 0,
  };
}

export type LogSample = {
  service_name: string | null;
  severity: string | null;
  body: string | null;
  cloudwatch_log_group_name: string | null;
};

/**
 * Runs a SQL query against a log stream over the last `minutes`, newest first.
 *
 * CONTRACT: Return `[]`, never an error, for a stream that does not exist. OpenObserve
 * infers a schema from ingested data, so a never-written stream 404s; the
 * unclassified-stream spec asserts absence as the HEALTHY state, and failing on the
 * 404 would invert that test. See [[logging-context]]
 */
export async function queryLogs(
  stream: string,
  sql: string,
  minutes: number,
  size = 20,
): Promise<LogSample[]> {
  const end = Date.now() * 1_000;
  const start = end - minutes * 60 * 1_000 * 1_000;

  const res = await fetch(`${openobserveBaseURL}/api/${org}/_search?type=logs`, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: { sql, start_time: start, end_time: end, from: 0, size },
    }),
  });

  // CONTRACT: Treat OpenObserve code 20002 as absence, matched on the numeric `code`
  // and never on the message text. `_search` reports a never-written stream as HTTP
  // 400, not 404, so handling only 404 kills the spec in the very state it asserts —
  // an empty `unclassified` stream IS the healthy outcome — and a reworded message
  // would silently turn "stream is empty" back into a hard failure.
  const raw = await res.text();
  if (res.status === 404) return [];
  if (!res.ok) {
    let notFound = false;
    try {
      notFound = (JSON.parse(raw) as { code?: number }).code === 20002;
    } catch {
      notFound = false;
    }
    if (notFound) return [];
    throw new Error(`OpenObserve search failed on stream "${stream}": ${res.status} ${raw}`);
  }

  const body = JSON.parse(raw) as { hits?: LogSample[]; code?: number };
  if (body.code === 404) return [];
  return body.hits ?? [];
}

/** Lists every stream the org knows about, as `"<type>:<name>"` — used only to enrich failure messages. */
export async function listStreams(): Promise<string[]> {
  const res = await fetch(`${openobserveBaseURL}/api/${org}/streams`, {
    headers: { Authorization: authHeader },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { list?: Array<{ name: string; stream_type: string }> };
  return (body.list ?? []).map((s) => `${s.stream_type}:${s.name}`);
}
