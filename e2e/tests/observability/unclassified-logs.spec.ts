// Log-convention contract — fails when any producer emits a record the
// collector cannot classify.
//
// ## The failure this layer exists to catch
//
// Every log line is supposed to carry `service_name` and a real severity
// ([[logging-context]]). A producer that emits an unrecognized shape does not
// break anything loudly: the record still ingests, but with `severity` 0
// (OTel UNSPECIFIED, which is NOT "below DEBUG") and no service identity. It
// then appears in no severity-filtered dashboard and no service_name query —
// present, consuming storage, and invisible.
//
// That condition has now shipped four separate times in this repo (nginx
// startup lines, Valkey chatter, the tracking codegen scripts' `print()`, and
// the CloudWatch-prefixed Lambda records). Every one was found by a human
// reading raw data, because nothing surfaced it. This spec is what turns the
// fifth occurrence into a red test instead of a discovery weeks later.
//
// ## Why it asserts on a STREAM, not on a severity query
//
// The collector now routes anything it could not fully parse to its own
// `unclassified` stream (see observability/otel-collector-config.yaml). Two
// independent faults send a record there, and neither implies the other:
// a missing `service_name` (the line was not understood at all) and a severity
// of 0 (OTel UNSPECIFIED — "nobody said", not "below DEBUG"). A producer that
// logs its identity but forgets the severity fields trips only the second.
//
// Asserting on the stream makes the check trivial and, more importantly,
// honest: the healthy state is "this stream does not exist or has no rows in
// the window", and any row is a named, readable example of the exact producer
// that regressed.
//
// Querying the main `logs` stream for `severity = 0` would NOT work as a
// replacement, because those records no longer land there — that is the whole
// point of the split. Asserting against the stream is asserting against the
// mechanism actually in use.
//
// ## Why it generates traffic first
//
// Same reason as dashboards.spec.ts: an idle stack proves nothing. A spec that
// passes because nothing was logged is a spec that cannot fail, and this one
// must be able to fail. It drives a real flow through the gateway, waits for
// the collector to flush, and only then reads.
//
// ## Known scope limit — the CloudWatch poll cycle
//
// Records from Lambda and the managed engines reach the collector through the
// `aws_cloudwatch` receiver on a ~1-minute poll, so the window read here is
// deliberately WIDER than the traffic this spec generates. That means it can
// also catch a bad record produced by something else moments earlier, which is
// a feature, not a leak: the assertion is "nothing unclassified is arriving",
// not "my requests specifically were clean".

import { expect, test } from "@playwright/test";

import {
  isOpenObserveReachable,
  openobserveBaseURL,
  queryLogs,
} from "../../support/openobserve-client";

/** Read a wider window than the traffic below, to cover the CloudWatch poll cycle. */
const WINDOW_MINUTES = 10;

/** Long enough for the collector's batch processor to flush and for one CloudWatch poll. */
const FLUSH_WAIT_MS = 20_000;

const gatewayURL = process.env.API_GATEWAY_URL ?? "";

test.describe("log conventions @observability", () => {
  test.beforeAll(async () => {
    test.skip(
      !(await isOpenObserveReachable()),
      `OpenObserve is not reachable at ${openobserveBaseURL} — run \`make observability-up\``,
    );
  });

  test("no producer emits records the collector cannot classify", async ({ request }) => {
    test.slow();

    // Generate real traffic so the assertion has something to be wrong about.
    // Every call is best-effort: this spec asserts on how things are LOGGED, not
    // on whether these endpoints succeed — the other suites own that. A 4xx here
    // still produces log lines, which is all this needs.
    if (gatewayURL) {
      const email = `unclassified-${Date.now()}@example.com`;
      await request
        .post(`${gatewayURL}/v1/users/register/passwordless`, {
          data: { email, fullName: "Log Convention Probe" },
          failOnStatusCode: false,
        })
        .catch(() => undefined);
      await request
        .post(`${gatewayURL}/v1/users/otp/start`, {
          data: { email },
          failOnStatusCode: false,
        })
        .catch(() => undefined);
      // A deliberately malformed body, to exercise the error paths too: a
      // failure log is just as bound by the conventions as a success log, and
      // error branches are where an ad-hoc `print()` tends to survive.
      await request
        .post(`${gatewayURL}/v1/users/otp/verify`, {
          data: { nonsense: true },
          failOnStatusCode: false,
        })
        .catch(() => undefined);
    }

    await new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS));

    // `SELECT *`, never a column list. OpenObserve infers a stream's schema from
    // what has been ingested, so naming a column it has not seen fails the whole
    // query with "No field named X" instead of returning rows — and this stream
    // is, by design, the one whose contents are least predictable. Naming
    // `service_name` here failed exactly that way against a stream whose only
    // records lacked it, which is the very case the spec must be able to report.
    const offenders = await queryLogs(
      "unclassified",
      "SELECT * FROM unclassified ORDER BY _timestamp DESC",
      WINDOW_MINUTES,
    );

    // Report the ACTUAL offending lines, not just a count. "Got 3 unclassified
    // records" cannot distinguish a broken system from a wrong expectation, and
    // the whole cost of this class of bug is in identifying WHICH producer
    // regressed — so the failure message hands that over directly.
    const detail = offenders
      .slice(0, 5)
      .map((r, i) => {
        const group = r.cloudwatch_log_group_name ?? "(no log group — arrived over fluent_forward)";
        const preview = (r.body ?? "").slice(0, 200);
        return `  ${i + 1}. group=${group}\n     body=${preview}`;
      })
      .join("\n");

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `${offenders.length} log record(s) reached OpenObserve without a service_name or ` +
          `with severity 0 (OTel UNSPECIFIED), so the collector could not fully classify them. ` +
          `They are invisible to every severity- and service-filtered dashboard.\n\n` +
          `Fix the PRODUCER (emit service_name + severity_text/severity_number per ` +
          `docs/shared/conventions/logging-context.md), not the collector — see ` +
          `docs/lessons/2026-08-16-cloudwatch-lambda-log-prefix-defeats-json-parse.md ` +
          `for why a collector-side patch tends to hide the real break.\n\n` +
          `Offending records (newest first):\n${detail}`,
    ).toHaveLength(0);
  });
});
