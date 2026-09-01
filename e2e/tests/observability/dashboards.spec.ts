// CONTRACT: Dashboard panels query fields BY NAME — rename/drop yields empty panels.
// Assert FIELDS not rows; derive waits from loadDashboardQueries().
// Do NOT DELETE live OpenObserve streams via API — HTTP 400 drops batches permanently.
// See [[logging-context]]

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

// WHY: Poll instead of fixed sleep — events-pipeline logs arrive via aws_cloudwatch
// on poll_interval 1m; 150s clears one full cycle plus batch flush margin.
const INGEST_TIMEOUT_MS = 150_000;
const INGEST_POLL_MS = 3_000;

// See [[logging-context]]

// WHY: Labels pipeline-only fields for timeout diagnosis (ingestion lag vs removal).
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

// CONTRACT: requiredLogFields() derives from loadDashboardQueries(); failed login emits `reason`.
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

// CONTRACT: describe.configure({ timeout }) does NOT apply to hooks — raise
// test.setTimeout in beforeAll or ingestion poll dies at 30s with no diagnostic.
test.describe.configure({ mode: "serial", timeout: 240_000 });

/** Drives register→order flow so every dashboard log field is emitted once. */
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

  // WHY: Failed login emits `reason` over OTLP so the ingestion wait can satisfy
  // failure-only fields the dashboard panels query.
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

/** Poll until every required log field appears; timeout names missing fields. */
async function waitForLogIngestion(required: string[]): Promise<StreamSchema> {
  const deadline = Date.now() + INGEST_TIMEOUT_MS;
  let schema: StreamSchema | null = null;

  // WHY: Only `_timestamp`/`service_name` after grace period means dead ingestion.
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

  // WHY: All-missing pipeline fields imply CloudWatch poll lag, not dashboard defect.
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
