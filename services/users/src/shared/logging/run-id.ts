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
 * THE SAME PATTERN THE COGNITO TRIGGER ENFORCES
 * (`infra/modules/cognito/otp-challenge-lambda/index.mjs`). The two ends must
 * agree: this service can hand the id to Cognito's ClientMetadata, and the
 * trigger re-validates it there because it arrives from a caller-controlled
 * field. A value accepted here and rejected there would be silently dropped on
 * exactly one of the three OTP-carrying paths.
 *
 * The character class is deliberately wider than the nano-id alphabet — the
 * suite mints ids like `run_2026-08-29T12-00-00_abc123`, which carry a
 * timestamp — and deliberately excludes anything that could break a log line or
 * a Mongo filter.
 */
const RUN_ID_PATTERN = /^run_[A-Za-z0-9_:.-]{1,64}$/;

/**
 * The run id for an inbound request, or `undefined`.
 *
 * TWO conditions, both required. The flag comes first: this is a test-only
 * field, and an environment that never sets `E2E_TESTING_ENABLED` must behave
 * as if the header did not exist — the same stance `x-e2e-source` takes on
 * /v1/users/register. Then the shape, because the value is untrusted input that
 * ends up on every log line of the request, on every event it publishes, and in
 * a document in the pipeline's fixture collection.
 *
 * WHY NOT REJECT THE REQUEST, and why not generate a fallback. A malformed run
 * id is not a reason to fail an otherwise valid request, so it is discarded
 * silently — but unlike `request_id` there is nothing to fall back to: minting
 * one here would attribute the event to a run that never existed, which is
 * worse than having no attribution at all. Absent is the honest answer.
 */
export function resolveRunId(headerValue: unknown, e2eTestingEnabled: boolean): string | undefined {
  if (!e2eTestingEnabled) return undefined;
  return typeof headerValue === "string" && RUN_ID_PATTERN.test(headerValue)
    ? headerValue
    : undefined;
}
