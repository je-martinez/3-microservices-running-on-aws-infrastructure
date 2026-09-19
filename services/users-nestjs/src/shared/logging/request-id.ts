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
 * `req_` plus the shared nano-id alphabet and length, DERIVED from NanoIdConfig rather
 * than written out — a hand-written pattern is how a service starts rejecting its own
 * ids after the format changes.
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
 * CONTRACT: Validate the header, and discard silently rather than rejecting the
 * request. It is untrusted input copied onto EVERY log line of the flow and forwarded
 * downstream, so an unbounded value bloats the stream, control characters corrupt the
 * JSON a dashboard parses, and another service's id shape makes a query correlate the
 * wrong things. A 400 would turn an observability nicety into an outage; a fresh id
 * keeps the flow correlated end to end.
 * See [[2026-08-15-request-id-correlation-design]]
 */
export function resolveRequestId(headerValue: unknown): string {
  return typeof headerValue === "string" && REQUEST_ID_PATTERN.test(headerValue)
    ? headerValue
    : generateRequestId();
}
