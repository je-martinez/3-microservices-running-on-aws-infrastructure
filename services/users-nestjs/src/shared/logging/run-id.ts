/**
 * The header carrying the Playwright suite's run id into this service.
 *
 * Lowercase because Node normalises incoming header names; the e2e clients send
 * the same spelling.
 */
export const RUN_ID_HEADER = "x-e2e-run-id";

/**
 * `run_` followed by up to 64 id-safe characters.
 *
 * CONTRACT: This pattern must stay identical to the one the Cognito OTP trigger
 * enforces. The id travels through ClientMetadata and the trigger re-validates it
 * there, so a value accepted here and rejected there is silently dropped on exactly
 * one of the three OTP paths. Wider than the nano-id alphabet (the suite mints
 * timestamped ids) but excluding anything that breaks a log line or a Mongo filter.
 * See [[logging-context]]
 */
const RUN_ID_PATTERN = /^run_[A-Za-z0-9_:.-]{1,64}$/;

/**
 * The run id for an inbound request, or `undefined`.
 *
 * CONTRACT: Both conditions are required, flag first — an environment without
 * `E2E_TESTING_ENABLED` must behave as if the header never arrived. Then the shape,
 * since the value reaches every log line, every published event, and a document in
 * the pipeline's fixture collection. Do NOT mint a fallback the way `request_id`
 * does: an invented run id attributes the event to a run that never existed, which is
 * worse than no attribution.
 * See [[logging-context]]
 */
export function resolveRunId(headerValue: unknown, e2eTestingEnabled: boolean): string | undefined {
  if (!e2eTestingEnabled) return undefined;
  return typeof headerValue === "string" && RUN_ID_PATTERN.test(headerValue)
    ? headerValue
    : undefined;
}
