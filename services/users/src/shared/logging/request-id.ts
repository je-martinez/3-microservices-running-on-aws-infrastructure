import { generateId } from "#shared/id/nano-id";

/**
 * The header carrying the correlation id between services.
 *
 * Lowercase because Node normalises incoming header names; outbound callers in
 * this repo send the same spelling.
 */
export const REQUEST_ID_HEADER = "x-request-id";

/** The `prefix_nanoid` prefix for a request id — see [[nano-id]]. */
const REQUEST_ID_PREFIX = "req_";

/**
 * `req_` followed by nanoid's default 21-character alphabet.
 *
 * Anchored at both ends, and the length is exact rather than a range: this is
 * the only thing standing between an untrusted header and every log line of the
 * request.
 */
const REQUEST_ID_PATTERN = /^req_[A-Za-z0-9_-]{21}$/;

/** A new correlation id. */
export function generateRequestId(): string {
  return generateId(REQUEST_ID_PREFIX);
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
