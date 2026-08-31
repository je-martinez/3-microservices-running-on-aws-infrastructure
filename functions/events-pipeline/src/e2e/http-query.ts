import { timingSafeEqual } from "node:crypto";
import { env, e2eTestingEnabled } from "#shared/config/env";
import type { E2eEmailStore } from "#e2e/email-store";

export interface FunctionUrlEvent {
  requestContext?: { http?: { method?: string } };
  queryStringParameters?: Record<string, string | undefined> | null;
  headers?: Record<string, string | undefined>;
}

export interface FunctionUrlResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// The discriminator for handler.ts's event union. Keyed on requestContext.http,
// which an SQS batch and the EventBridge tick both lack — a false positive here
// would route real messages into the query path and silently drop them.
export function isFunctionUrlEvent(event: unknown): event is FunctionUrlEvent {
  return typeof (event as FunctionUrlEvent)?.requestContext?.http?.method === "string";
}

const NOT_FOUND: FunctionUrlResponse = {
  statusCode: 404,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "Not Found" }),
};

function json(statusCode: number, payload: unknown): FunctionUrlResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

// Constant-time, and length-safe: timingSafeEqual throws on a length mismatch,
// so the lengths are compared first — and that comparison leaks only the
// length, which an attacker supplying the candidate already knows.
function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function handleEmailQuery(
  event: FunctionUrlEvent,
  store: E2eEmailStore,
): Promise<FunctionUrlResponse> {
  // Three conditions, all required, all answering 404 — never 401 or 403, and
  // never a body that distinguishes them. This route serves plaintext OTP
  // codes; a 403 would confirm it exists on a function that holds them.
  //
  // An UNSET token disables the route rather than opening it: the failure mode
  // of a missing secret must be closed.
  if (!e2eTestingEnabled) return NOT_FOUND;
  if (!env.E2E_QUERY_TOKEN) return NOT_FOUND;

  const headers = event.headers ?? {};
  // Function URL header names arrive lowercased, but a proxy may not; accept
  // either spelling rather than failing obscurely.
  const presented = headers["x-e2e-token"] ?? headers["X-E2E-Token"];
  if (!tokenMatches(presented, env.E2E_QUERY_TOKEN)) return NOT_FOUND;

  const method = event.requestContext?.http?.method;
  if (method !== "GET") return json(405, { message: "Method Not Allowed" });

  const params = event.queryStringParameters ?? {};
  const runId = params.runId;
  // An unscoped query is never correct: workers and reruns share this
  // collection, so a missing runId would hand back another run's mail.
  if (!runId) return json(400, { message: "runId is required" });

  const emails = await store.query({
    runId,
    to: params.to,
    templateKey: params.templateKey,
    limit: params.limit ? Number(params.limit) : undefined,
  });

  return json(200, { count: emails.length, emails });
}
