// Dashboard field contract — stops the OpenObserve dashboards from silently
// breaking when a service renames or drops a log/metric field.
//
// ## The failure this layer exists to catch
//
// Every panel queries fields BY NAME (`http_route`, `duration_ms`,
// `service_name`, …). When a service stops emitting one, OpenObserve answers
// `Search field not found: Schema error: No field named X` and the panel renders
// empty. Nothing fails, nothing alerts — the break is only visible to whoever
// happens to open the dashboard. This spec turns that into a test failure.
//
// ## Two failure modes that look identical, and only one is a bug
//
// This distinction IS the design of this spec, not a detail of it:
//
//   1. REAL BUG — the dashboard queries a field no service emits any more.
//      Must fail.
//   2. NOT A BUG — the field is correct, but the stream is EMPTY, so OpenObserve
//      has not inferred it yet. OpenObserve derives a stream's schema from
//      ingested data, so a freshly-cleaned stream reports little more than
//      `_timestamp` and `service_name` and EVERY panel looks broken.
//
// A spec that cannot tell them apart fails constantly for reason 2 and gets
// ignored, which is worse than no spec. So this one GENERATES A REAL FLOW FIRST
// (register → login → products → order → tracking), waits for those logs to
// land, and only then asserts. When a stream still looks trivial afterwards, it
// fails with "this stream looks un-ingested" rather than blaming the dashboards.
//
// ## The wait must cover every producer, not just the fast ones
//
// Reason 2 has a subtler form that bit this spec repeatedly, and it is worth
// stating plainly because it is invisible on a warm stack: the flow above
// reaches FOUR producers, and they do not arrive on the same timescale.
// Users/orders/tracking push over OTLP in milliseconds, while the
// events-pipeline is a Lambda whose logs the collector pulls on a 1-minute
// `aws_cloudwatch` poll. Waiting only for the fast producers' fields and then
// asserting on all of them is a race the slow producer loses on a clean stream,
// and it reported the false "no service emits author_actor any more" that this
// design note now exists to prevent. The wait is therefore derived from the
// dashboards themselves — see requiredLogFields() below.
//
// ## Reproducing the empty stream: delete the VOLUME, never the stream
//
// Written down because it cost real time and will mislead the next person the
// same way. The obvious way to recreate a fresh stack's empty stream is
// `DELETE /api/{org}/streams/logs?type=logs` against a running stack. DO NOT —
// it does not emulate `make clean`, it breaks ingestion for the next minutes:
//
//   openobserve  [Schema:watch] flushed cache for stream 3mrai/logs/logs
//   collector    Exporting failed. Dropping data. … HTTP Status Code 400,
//                "not retryable error: Permanent error", dropped_items: 25
//
// Deleting a live stream invalidates OpenObserve's schema cache while the
// collector is mid-flight, and the batches that race the invalidation are
// rejected 400 and dropped PERMANENTLY — the collector does not retry a
// permanent error. The result looks exactly like the bug this spec hunts (a
// field "missing" from the schema) but the records were destroyed in transit.
// Confirmed by correlation: zero 400s in the hour before the first manual
// delete, then a burst within the same minute as every one that followed.
//
// `make clean` is safe precisely because it removes the openobserve-data volume
// and restarts the container — the collector reconnects to a cold server rather
// than racing a cache flush under a live one. So: reproduce with a real
// `make clean` + `make bootstrap`, or trust the assertions below.
//
// ## Why fields, not rows
//
// This asserts the FIELDS EXIST, never that a query RETURNS ROWS. A panel can be
// legitimately empty and correct: "recent errors" shows nothing when there were
// no 5xx in the window, and "orders delivered" is zero before anything ships.
// Asserting on rows would make a healthy system red, which is exactly the kind
// of noise that gets a suite muted.
//
// ## Streams covered — and the one that is not
//
//   COVERED  logs (all 24 SQL panels across users/orders/tracking/
//            events-pipeline/overview) — driven directly by the traffic below.
//   COVERED  the metrics streams (amazonaws_com_3mrai_*, 10 SQL cards +
//            3 PromQL panels on business-metrics/tracking). These are fed by
//            CloudWatch polling on a ~1-minute cycle and by the business-metrics
//            publishers, NOT by this spec's traffic — so they are asserted only
//            when the stream already exists, and skipped with a named reason
//            when it does not. Generating them here would mean waiting minutes
//            on a background poller, which is the flakiness the task warned
//            against; a stale-but-present schema still catches a renamed label.
//   NOT COVERED  the `sql`, `redis` and `nginx` log streams. Deliberate, and not
//            an omission: no committed dashboard panel reads them today
//            (verified across all six files). They will be covered
//            automatically the moment a panel does, because the assertions are
//            driven by the dashboards, not by a hardcoded stream list.

import { test, expect } from "@playwright/test";
import { apiClient, ordersClient, trackingClient } from "../../support/api-client.js";
import { makeUser } from "../../support/chance-factory.js";
import { loadDashboardQueries, type PanelQuery } from "../../support/dashboard-parser.js";
import {
  fetchStreamSchema,
  isOpenObserveReachable,
  listStreams,
  openobserveBaseURL,
  type StreamSchema,
} from "../../support/openobserve-client.js";

// OpenObserve infers a schema from ingested data, so these two are present even
// on a stream that has received nothing meaningful. Seeing ONLY these is the
// signature of "no traffic arrived", not of "the dashboards are wrong".
const TRIVIAL_LOG_FIELDS = new Set(["_timestamp", "service_name"]);

// The collector batches, and the CloudWatch-sourced logs poll on ~60s. Poll for
// the data instead of sleeping a fixed guess — a fixed sleep is either too short
// (flaky) or too long (slow), and it never says which.
//
// The timeout must clear a FULL CloudWatch cycle plus the batch flush behind it,
// not just one. The events-pipeline is a Lambda, so its lines reach OpenObserve
// through `aws_cloudwatch` on a `poll_interval: 1m` (observability/
// otel-collector-config.yaml) — traffic generated just after a poll waits out
// the remainder of that minute before the next one even starts. 90s left almost
// no margin for the flush that follows; 150s clears the worst-case cycle twice
// over and still fails fast, because the wait below returns the moment the
// fields arrive rather than sleeping to the deadline.
const INGEST_TIMEOUT_MS = 150_000;
const INGEST_POLL_MS = 3_000;

// The fields to wait for are DERIVED FROM THE DASHBOARDS, never hardcoded.
//
// ## The false positive this replaced, and why a hardcoded list caused it
//
// This used to be the literal `["http_route", "duration_ms",
// "http_response_status_code"]` — three fields that users/orders/tracking push
// straight over OTLP. The assertion, however, covers every field ANY log panel
// queries, and five of those (`app_event`, `author_actor`, `event_id`, `reason`,
// `severity_text`) are emitted ONLY by the events-pipeline, which arrives on the
// slow CloudWatch path described above. So the wait watched the fast producer
// and then asserted on the slow one: on a freshly-cleaned stream it returned as
// soon as the HTTP fields landed and the assertion ran a minute too early,
// reporting `missing field(s): author_actor … (doc_num=0)` and claiming "no
// service emits it any more". That claim was FALSE — `author_actor` is emitted
// at functions/events-pipeline/src/handler.ts:111 on every record — and the
// giveaway was `doc_num=0`: the stream was simply still empty.
//
// Deriving the list from `loadDashboardQueries()` closes the gap permanently and
// makes the spec STRICTER, not weaker: the wait and the assertion now read the
// same source, so a panel that starts querying a new field is waited for
// automatically instead of racing it. A field genuinely removed from a producer
// still fails — it never arrives, the wait times out, and the message below
// names it.
// ## The one field a SUCCESSFUL flow would never produce, and why it is still waited for
//
// `reason` is written exclusively on failure branches — [[logging-context]]
// states it as a rule ("`reason` on failures"), and the pipeline follows it at
// functions/events-pipeline/src/handler.ts:582/736/747, as does Users at
// features/users/commands/login.ts:66/99. A spec that generated only a happy
// path could therefore never satisfy a wait on `reason`, and measuring said
// exactly that: against a freshly-deleted stream this wait timed out after the
// full 150s with `Never arrived: reason` while all ten other fields had landed.
//
// There were two ways out and only one of them is honest. Excluding `reason`
// from the wait would have moved the same failure into the assertion a second
// later — verified: the rebuilt stream genuinely has no `reason` column — which
// is a false positive relocated, not removed. So `generateTraffic()` now drives
// a REAL failing login instead, which makes `reason` an ordinary unconditional
// field like the rest and keeps the assertion at full strength.

// Fields that ONLY the events-pipeline emits — used to tell ingestion lag from a
// real removal in the timeout message, never to relax an assertion.
//
// Derived from the dashboards, not hand-listed: a field counts as
// pipeline-only when EVERY panel querying it filters on
// `service_name = 'events-pipeline'`. That keeps the set honest as panels
// change — the moment another service's panel starts querying one of these, it
// stops being pipeline-only and the message stops making excuses for it.
function eventsPipelineOnlyFields(panelQueries: PanelQuery[]): Set<string> {
  const producers = new Map<string, Set<string>>();
  for (const q of panelQueries) {
    if (q.streamType !== "logs" || q.stream !== "logs") continue;
    // The service each panel scopes itself to. A panel with no `service_name`
    // filter spans every producer, so it is recorded as "*" — which can never
    // equal the single-producer test below and therefore correctly disqualifies
    // its fields.
    const scoped = [...q.query.matchAll(/service_name\s*=\s*'([^']+)'/g)].map((m) => m[1]);
    const owners = scoped.length ? scoped : ["*"];
    for (const f of q.fields) {
      if (!producers.has(f)) producers.set(f, new Set());
      for (const o of owners) producers.get(f)!.add(o);
    }
  }

  const only = new Set<string>();
  for (const [field, owners] of producers) {
    if (owners.size === 1 && owners.has("events-pipeline")) only.add(field);
  }
  return only;
}

function requiredLogFields(panelQueries: PanelQuery[]): string[] {
  const fields = new Set<string>();
  for (const q of panelQueries) {
    if (q.streamType !== "logs" || q.stream !== "logs") continue;
    for (const f of q.fields) fields.add(f);
  }
  // `_timestamp` and `service_name` exist on an EMPTY stream (OpenObserve
  // creates them for free), so waiting on them would return instantly and
  // reinstate the very race this function exists to remove.
  for (const trivial of TRIVIAL_LOG_FIELDS) fields.delete(trivial);
  return [...fields].sort();
}

// Unreachable OpenObserve is a missing PREREQUISITE, not a defect. This project
// is the only one needing `make observability-up`, so it says so by name instead
// of failing with a connection error somebody has to decode.
test.beforeAll(async () => {
  const reachable = await isOpenObserveReachable();
  test.skip(
    !reachable,
    `OpenObserve is not reachable at ${openobserveBaseURL}. This project needs the observability ` +
      "stack: run `make observability-up` from the repo root, then re-run. " +
      "(The other E2E projects do not need it, which is why this skips rather than fails.)",
  );
});

// Generating traffic + waiting for ingestion is the slow part and runs once.
//
// `describe.configure({ timeout })` sets the TEST timeout only — hooks keep the
// 30s default, which is shorter than the ingestion poll below. Without the
// explicit `setTimeout` in the hook itself, a stream that never ingests fails
// with a bare "beforeAll hook timeout of 30000ms exceeded" and the diagnostic
// message this spec exists to print is never reached. Observed, then fixed.
test.describe.configure({ mode: "serial", timeout: 240_000 });

/**
 * Drives one real end-to-end flow so every field the dashboards care about has
 * been emitted at least once by every service they chart.
 *
 * Uses the direct-service clients (the `internal` layer): the point here is to
 * make the three services LOG, and each emits the same HTTP attributes whether
 * the call arrived via the gateway or not. Going direct removes the Cognito
 * round-trip from a spec that is not testing auth.
 *
 * `X-E2E-Source` comes from the shared clients, so everything created here is
 * torn down by the usual global teardown.
 */
async function generateTraffic(): Promise<void> {
  const users = await apiClient();
  const orders = await ordersClient();
  const tracking = await trackingClient();

  // 1. register — Users logs the request and emits users_registered_total
  const user = makeUser();
  const registered = await users.post("/v1/users/register", { data: user });
  expect(registered.status(), `register failed: ${await registered.text()}`).toBe(201);
  const { id: userId } = (await registered.json()) as { id: string };

  // 2. login — a second Users route, so `http_route` has more than one value
  const login = await users.post("/v1/users/login", {
    data: { email: user.email, password: user.password },
  });
  expect(login.status(), `login failed: ${await login.text()}`).toBe(200);

  // 3. list products — first Orders route
  const products = await orders.get("/v1/products", { headers: { "x-user-id": userId } });
  expect(products.status()).toBe(200);
  const list = (await products.json()) as Array<{ id: string; unitsInStock: number }>;
  const product = list.find((p) => p.unitsInStock > 0);
  expect(product, "no product with stock — the catalog seed did not run").toBeTruthy();

  // 4. create an order — drives orders_total and, via init-tracking, Tracking
  const created = await orders.post("/v1/orders", {
    headers: { "x-user-id": userId },
    data: { lines: [{ productId: product!.id, quantity: 1 }] },
  });
  expect(created.status(), `create order failed: ${await created.text()}`).toBe(201);
  const order = (await created.json()) as { id: string };

  // 5. read the tracking — Orders calls init-tracking AFTER its own transaction
  //    commits, so the row appears a beat later. Polled, not slept on.
  const trackingDeadline = Date.now() + 20_000;
  let trackingStatus = 0;
  while (Date.now() < trackingDeadline) {
    const res = await tracking.get(`/v1/trackings/${order.id}`, {
      headers: { "x-user-id": userId },
    });
    trackingStatus = res.status();
    if (trackingStatus === 200) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(
    trackingStatus,
    `No tracking for ${order.id} after 20s (last status ${trackingStatus}). Orders creates it by ` +
      "calling POST /v1/trackings/init-tracking once its transaction commits.",
  ).toBe(200);

  // 6. one deliberate 4xx, so `http_response_status_code >= 400` — the field the
  //    "recent errors" panels filter on — is exercised with a real value rather
  //    than only ever being 200.
  const notFound = await orders.get("/v1/orders/ord_doesnotexist", {
    headers: { "x-user-id": userId },
  });
  expect([400, 404]).toContain(notFound.status());

  // 7. one deliberately WRONG password. The dashboards' "recent errors" panels
  //    select `reason`, and every producer writes that field on failure
  //    branches ONLY ([[logging-context]]: "`reason` on failures"). A purely
  //    successful flow therefore never emits it, and the ingestion wait below —
  //    which requires every field the panels query — could never be satisfied.
  //    Measured before this step existed: the wait ran its full 150s and failed
  //    with `Never arrived: reason` while all ten other fields had landed.
  //
  //    Users logs `app_event=login_failed, reason=invalid_credentials`
  //    (services/users/src/features/users/commands/login.ts:99) and pushes it
  //    over OTLP, so it lands in seconds rather than on the 1m CloudWatch poll.
  //    A rejected login is also the cheapest possible failure to provoke: it
  //    creates nothing, needs no teardown, and leaves no state behind.
  const badLogin = await users.post("/v1/users/login", {
    data: { email: user.email, password: `${user.password}-wrong` },
  });
  expect(
    [400, 401],
    `A deliberately wrong password should be REJECTED — a success here means the ` +
      `spec is no longer generating the failure log that "reason" comes from.`,
  ).toContain(badLogin.status());

  await Promise.all([users.dispose(), orders.dispose(), tracking.dispose()]);
}

/**
 * Waits until the `logs` stream has inferred EVERY field the log dashboards
 * query — the same set the assertions below check, passed in by the caller so
 * the two can never drift apart.
 *
 * Bounded, and on timeout it reports WHICH fields never arrived: a count alone
 * could not distinguish a slow collector from a renamed attribute, and naming
 * them is what lets the reader see at a glance whether the stragglers all belong
 * to one producer (ingestion lag) or are scattered (a real removal).
 */
async function waitForLogIngestion(required: string[]): Promise<StreamSchema> {
  const deadline = Date.now() + INGEST_TIMEOUT_MS;
  let schema: StreamSchema | null = null;

  // A stream that is COMPLETELY empty will not fill up by waiting on it — the
  // stack is down. Polling the full timeout there only delays the same verdict,
  // so give it a bounded grace period and then stop.
  //
  // "Completely empty" means ONLY the free fields, and that is the whole test.
  // It is deliberately NOT "some required field is still missing": a stream
  // holding the HTTP attributes but not yet the events-pipeline ones is
  // mid-ingestion — the fast OTLP producers have landed and the 1m CloudWatch
  // poll has not — and giving up there is exactly the bug being fixed. Only a
  // stream with nothing but `_timestamp`/`service_name` after the grace period
  // is genuinely dead.
  //
  // The grace period is deliberately generous relative to the ~4s a recreated
  // stream took to reappear when measured against this stack, while still
  // failing a genuinely dead stack in a fraction of the 150s deadline.
  const emptyStreamGiveUpAt = Date.now() + INGEST_POLL_MS * 5;

  while (Date.now() < deadline) {
    schema = await fetchStreamSchema("logs", "logs");
    if (schema && required.every((f) => schema!.fields.has(f))) return schema;

    const stillEmpty = !schema || [...schema.fields].every((f) => TRIVIAL_LOG_FIELDS.has(f));
    if (stillEmpty && Date.now() > emptyStreamGiveUpAt) break;

    await new Promise((r) => setTimeout(r, INGEST_POLL_MS));
  }

  const present = schema ? [...schema.fields].sort().join(", ") : "(stream does not exist)";
  const missing = schema ? required.filter((f) => !schema!.fields.has(f)) : required;

  // Distinguish the shapes of timeout in the message itself, because they send
  // the reader to completely different places.
  const nonTrivial = schema ? [...schema.fields].filter((f) => !TRIVIAL_LOG_FIELDS.has(f)) : [];

  // Whether the stragglers are ALL from the slow producer decides the verdict.
  // The events-pipeline is a Lambda polled by `aws_cloudwatch` every minute,
  // while users/orders/tracking push over OTLP in milliseconds — so "only the
  // pipeline's fields are missing" is the signature of ingestion lag (or a
  // Lambda that never ran), whereas a field missing from a producer that HAS
  // otherwise landed is a genuine removal. Saying which one it is here is the
  // difference between a reader fixing the stack and a reader wrongly editing
  // the dashboard JSON — the exact wrong turn this spec once caused.
  const onlySlowProducerMissing =
    missing.length > 0 && missing.every((f) => EVENTS_PIPELINE_ONLY_FIELDS.has(f));

  const diagnosis =
    nonTrivial.length === 0
      ? "The stream holds ONLY the fields OpenObserve creates for free, so NOTHING was ingested. " +
        "This is an INGESTION problem, NOT a dashboard problem — do not touch the dashboard JSON. " +
        "Check that `make observability-up` is running and that the OTel collector can reach " +
        "OpenObserve."
      : onlySlowProducerMissing
        ? "Every missing field belongs to the EVENTS-PIPELINE, and only to it. That producer is a " +
          "Lambda whose logs reach OpenObserve through the collector's `aws_cloudwatch` receiver " +
          "on a 1-minute poll, so this is almost certainly INGESTION LAG or a pipeline that never " +
          "ran — NOT a dashboard defect. Check that the events Lambda is consuming the SQS queue " +
          "(a deep queue delays it by minutes; see e2e/CLAUDE.md §4) before touching any JSON."
        : "The stream IS ingesting other fields, so the collector works and these specific " +
          "attributes stopped being emitted. That means the dashboards querying them are genuinely " +
          "broken, and the field names above are the evidence.";

  throw new Error(
    `The "logs" stream did not gain every field the dashboards query within ` +
      `${INGEST_TIMEOUT_MS / 1000}s after this spec generated traffic.\n` +
      `  Never arrived: ${missing.join(", ")}\n` +
      `  Currently in the schema: ${present}\n` +
      `  doc_num: ${schema?.docCount ?? 0}\n` +
      diagnosis,
  );
}

/** Fails a stream that carries nothing but the fields OpenObserve creates for free. */
function assertStreamIsIngested(stream: string, schema: StreamSchema): void {
  const nonTrivial = [...schema.fields].filter((f) => !TRIVIAL_LOG_FIELDS.has(f));
  expect(
    nonTrivial.length,
    `Stream "${stream}" looks UN-INGESTED, so the dashboards cannot be judged against it: its ` +
      `schema holds only ${[...schema.fields].sort().join(", ")} (doc_num=${schema.docCount}).\n` +
      "OpenObserve infers a schema from ingested data, so an empty stream makes every panel look " +
      "broken. This is NOT a dashboard defect — check that the collector is running and that " +
      "traffic reached the services.",
  ).toBeGreaterThan(0);
}

let logSchema: StreamSchema;
let queries: PanelQuery[];
/** Populated in the hook below, read only by waitForLogIngestion's diagnosis. */
let EVENTS_PIPELINE_ONLY_FIELDS: Set<string> = new Set();

test.beforeAll(async () => {
  // Hooks do NOT inherit the describe-level timeout (see the configure() note
  // above), so this must be raised here or the ingestion poll is cut short.
  // Comfortably above INGEST_TIMEOUT_MS so the poll reaches its own deadline and
  // throws the diagnostic below, rather than being cut off by a hook timeout
  // that says only "30000ms exceeded".
  test.setTimeout(240_000);
  queries = loadDashboardQueries();
  EVENTS_PIPELINE_ONLY_FIELDS = eventsPipelineOnlyFields(queries);
  await generateTraffic();
  logSchema = await waitForLogIngestion(requiredLogFields(queries));
});

test("the dashboards parse and reference at least one stream", () => {
  expect(queries.length, `No panel queries found under observability/dashboards/`).toBeGreaterThan(0);
  const logQueries = queries.filter((q) => q.streamType === "logs");
  expect(logQueries.length, "No log-stream panels found — the parser is reading the wrong key").toBeGreaterThan(0);
});

test("the logs stream is ingested (guards the empty-stream false alarm)", () => {
  assertStreamIsIngested("logs", logSchema);
});

test("every LOG-stream panel field exists in its stream schema", async () => {
  const logQueries = queries.filter((q) => q.streamType === "logs");

  // Schemas fetched once per stream, not once per panel.
  const schemas = new Map<string, StreamSchema>();
  for (const q of logQueries) {
    if (schemas.has(q.stream)) continue;
    const schema = await fetchStreamSchema(q.stream, "logs");
    if (!schema) {
      throw new Error(
        `Log stream "${q.stream}" does not exist in OpenObserve, but ` +
          `${q.dashboard} panel "${q.panelTitle}" (${q.panelId}) queries it.\n` +
          `  Streams that DO exist: ${(await listStreams()).join(", ")}`,
      );
    }
    assertStreamIsIngested(q.stream, schema);
    schemas.set(q.stream, schema);
  }

  const failures: string[] = [];
  for (const q of logQueries) {
    const schema = schemas.get(q.stream)!;
    const missing = q.fields.filter((f) => !schema.fields.has(f));
    if (missing.length) {
      failures.push(
        `${q.dashboard} → panel "${q.panelTitle}" (${q.panelId})\n` +
          `    missing field(s): ${missing.join(", ")}\n` +
          `    in stream:        ${q.stream} (${schema.fields.size} fields, doc_num=${schema.docCount})\n` +
          `    query:            ${q.query}`,
      );
    }
  }

  expect(
    failures.join("\n\n"),
    `${failures.length} dashboard panel(s) reference log fields that no service emits any more. ` +
      "The stream IS ingested (checked above), so this is a REAL break: the panel will render " +
      '"Search field not found". Fix the dashboard JSON or restore the field in the service.',
  ).toBe("");
});

test("every METRICS-stream panel field exists in its stream schema", async () => {
  const metricQueries = queries.filter((q) => q.streamType === "metrics");
  test.skip(metricQueries.length === 0, "No metrics panels in the committed dashboards.");

  const existing = new Set(await listStreams());
  const schemas = new Map<string, StreamSchema | null>();
  const failures: string[] = [];
  const skipped: string[] = [];

  for (const q of metricQueries) {
    if (!schemas.has(q.stream)) {
      schemas.set(q.stream, await fetchStreamSchema(q.stream, "metrics"));
    }
    const schema = schemas.get(q.stream);

    // A metrics stream is created by the CloudWatch poller on its ~1-minute
    // cycle, NOT by this spec's traffic — so "absent" here means the poller has
    // not run yet on a fresh stack, which is not a dashboard defect. Recorded
    // and reported rather than silently passed, so the gap is visible.
    if (!schema) {
      skipped.push(
        `${q.stream} (${q.dashboard} → "${q.panelTitle}") — stream absent; the CloudWatch poller ` +
          "has not created it yet on this stack",
      );
      continue;
    }

    const missing = q.fields.filter((f) => !schema.fields.has(f));
    if (missing.length) {
      failures.push(
        `${q.dashboard} → panel "${q.panelTitle}" (${q.panelId}) [${q.queryType}]\n` +
          `    missing field(s): ${missing.join(", ")}\n` +
          `    in stream:        ${q.stream} (${schema.fields.size} fields, doc_num=${schema.docCount})\n` +
          `    query:            ${q.query}`,
      );
    }
  }

  if (skipped.length) {
    console.warn(
      `[dashboards] ${skipped.length} metrics panel(s) not verified — stream(s) not present yet:\n  ` +
        skipped.join("\n  ") +
        `\n  Streams present: ${[...existing].filter((s) => s.startsWith("metrics:")).join(", ") || "(none)"}`,
    );
  }

  expect(
    failures.join("\n\n"),
    `${failures.length} dashboard panel(s) reference metric labels that are not in the stream ` +
      "schema. The stream EXISTS (so data has been published), which makes this a real break: " +
      "the label was renamed or dropped by the publisher.",
  ).toBe("");
});
