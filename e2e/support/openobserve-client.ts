// Minimal OpenObserve read client for the dashboard-contract specs.
//
// Scope is deliberately narrow: reachability and stream schemas. Nothing here
// writes, and nothing here queries panel data — see
// tests/observability/dashboards.spec.ts for why asserting on ROWS would be the
// wrong contract to hold a dashboard to.
//
// Credentials: the local stack ships a fixed admin account (see
// observability/docker-compose.observability.yml). It is a local-only
// development credential, not a secret — the same literal appears in the
// dashboards README and in `make observability-up` output. Overridable so a
// differently-provisioned stack still works.

const DEFAULT_BASE_URL = "http://localhost:5080";
const DEFAULT_ORG = "3mrai";
const DEFAULT_AUTH = "Basic YWRtaW5AM21yYWkubG9jYWw6Q29tcGxleHBhc3MjMTIz";

export const openobserveBaseURL = process.env.OPENOBSERVE_URL ?? DEFAULT_BASE_URL;
const org = process.env.OPENOBSERVE_ORG ?? DEFAULT_ORG;
const authHeader = process.env.OPENOBSERVE_AUTH ?? DEFAULT_AUTH;

// OpenObserve models a stream's type as part of its IDENTITY, not as a filter:
// `logs` and a metrics stream can coexist under the same name, so the schema
// endpoint answers 404 — not an empty schema — when the type is omitted or
// wrong. Verified live: GET .../amazonaws_com_3mrai_users_total/schema returns
// `{"code":404,"message":"stream not found"}` while the same URL with
// `?type=metrics` returns the full schema. Dropping the param would therefore
// make every metrics panel look like a broken dashboard.
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

/** Lists every stream the org knows about, as `"<type>:<name>"` — used only to enrich failure messages. */
export async function listStreams(): Promise<string[]> {
  const res = await fetch(`${openobserveBaseURL}/api/${org}/streams`, {
    headers: { Authorization: authHeader },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { list?: Array<{ name: string; stream_type: string }> };
  return (body.list ?? []).map((s) => `${s.stream_type}:${s.name}`);
}
