// CONTRACT: No producer may emit records routed to `unclassified` — invisible in dashboards.
// Assert the unclassified stream (severity 0 records route there, not to main logs).
// Generate gateway traffic first; read a window wider than the CloudWatch poll cycle.
// See [[logging-context]]

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
