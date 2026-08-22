import { NanoIdConfig } from "#shared/id/nano-id";

/**
 * The header carrying the correlation id between services.
 *
 * Lowercase because Node normalises incoming header names; outbound callers in
 * this repo send the same spelling.
 */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * The `prefix_nanoid` prefix for a request id, read from the shared config
 * rather than declared here — see [[nano-id]]. Every prefix this service mints
 * lives in that one map so they can be audited for collisions together.
 */
const REQUEST_ID_PREFIX = NanoIdConfig.PREFIXES.Request;

/**
 * `req_` followed by the shared nano-id alphabet and length.
 *
 * DERIVED from NanoIdConfig rather than written out, so it cannot drift from
 * what the generator produces — a hand-written pattern is how a service starts
 * rejecting its own ids after the format changes. Anchored at both ends with an
 * exact length: this is the only thing standing between an untrusted header and
 * every log line of the request.
 */
const REQUEST_ID_PATTERN = NanoIdConfig.pattern(REQUEST_ID_PREFIX);

/** A new correlation id. */
export function generateRequestId(): string {
  return NanoIdConfig.newRequestId();
}

/**
 * The request id for an inbound request: the caller's if it is one of ours,
 * otherwise a fresh one.
 *
 * WHY VALIDATE AT ALL. The header is untrusted input — it arrives from the
 * gateway, another service, or a client typing curl — and whatever it says is
 * copied onto EVERY log line of the resulting flow and forwarded to every
 * downstream service. An unbounded value would bloat the log stream; control
 * characters would corrupt the JSON a dashboard parses; a value shaped like
 * another service's id would make a query correlate the wrong things. Accepting
 * only our own format keeps the field trustworthy for the one job it has.
 *
 * WHY NOT REJECT THE REQUEST. A malformed correlation header is not a reason to
 * fail an otherwise valid request: the caller asked for something legitimate and
 * a 400 would turn an observability nicety into an outage. Discarding silently
 * and generating a fresh id degrades exactly as far as it needs to — the flow is
 * still correlated end to end, just not with the caller's id.
 */
export function resolveRequestId(headerValue: unknown): string {
  return typeof headerValue === "string" && REQUEST_ID_PATTERN.test(headerValue)
    ? headerValue
    : generateRequestId();
}
