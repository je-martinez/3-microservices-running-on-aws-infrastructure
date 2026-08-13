---
title: Custom Business Metrics via CloudWatch — Implementation Plan
type: plan
area: shared
status: draft
created: 2026-08-12
updated: 2026-08-12
tags:
  - type/plan
  - area/shared
  - status/draft
propagates-to:
  - "[[logging-context]]"
  - "[[users-service-design]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
  - "[[events-pipeline-design]]"
  - "[[testing]]"
related:
  - "[[2026-08-12-custom-business-metrics-cloudwatch-design]]"
  - "[[env-files]]"
  - "[[logging-context]]"
  - "[[testing]]"
  - "[[ADR-0017-floci-local]]"
---

# Custom Business Metrics via CloudWatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish custom business metrics and HTTP error-rate metrics from all four services to
CloudWatch (Floci locally), scraped by the OTel collector into OpenObserve for dashboards.

**Architecture:** Each service publishes with `PutMetricData` — counters at the moment of the
event, gauges from a periodic task that `COUNT(*)`s its own database. The collector's existing
`aws_cloudwatch` receiver gains a `metrics` block that polls `GetMetricData` and exports to
OpenObserve. No service talks to OpenObserve directly, and no service reads another's database.

**Tech Stack:** AWS SDK CloudWatch clients (`@aws-sdk/client-cloudwatch` for Node, `boto3` for
Python, `AWSSDK.CloudWatch` for .NET), OpenTelemetry Collector contrib 0.156.0, Floci 1.5.28,
OpenObserve 0.91.1.

**Design spec:** [[2026-08-12-custom-business-metrics-cloudwatch-design]] — read it before
starting. The three spike findings it records are load-bearing for nearly every task here.

## Global Constraints

- **Namespace is `3MRAI`** for every metric in every service. Never per-service namespaces.
- **Every metric MUST be published with dimensions, and queried with the exact same dimension
  set.** Floci does not aggregate across dimensions: a query omitting a dimension returns
  `Values: []` with `StatusCode: "Complete"` — a silent empty result, not an error.
- **A "total" across a breakdown is published as its own series** with a sentinel dimension value
  (`EmailType=ALL`), never derived by omitting a dimension.
- **Metric publishing must NEVER break the operation that triggered it.** Log and swallow every
  failure, exactly as `SqsEventPublisher` (Orders), `sqs_event_publisher.py` (Tracking) and the
  events-pipeline's publishers already do. A metrics backend being down must never fail a
  registration, an order, or an email.
- **Intervals: 15s locally, 60s in real AWS.** `collection_interval` ≥ `period` is validated by
  the receiver at startup.
- **Dimension names in OpenObserve are prefixed and lowercased**: CloudWatch `Service` is queried
  as `dimensions_service`. Dashboards use the prefixed form; the collector's `queries` block and
  `GetMetricData` use the CloudWatch form.
- **Never log PII in metric code.** No emails, no codes. Metric *dimensions* are low-cardinality
  labels only — never a user id, email, or order id (that would explode cardinality and leak).
- Converse in Spanish; write all code, comments, and docs in **English**.
- Commits follow Conventional Commits: `<type>(<scope>): <description>`, scope ∈
  `users|orders|tracking|events-pipeline|infra|vault`.

## File Structure

**New shared-shape files (one per service, same responsibility, idiomatic to each stack):**

| Service | File | Responsibility |
|---|---|---|
| Users | `services/users/src/shared/metrics/cloudwatch-metrics.ts` | `MetricsPublisher` class wrapping `CloudWatchClient` |
| Users | `services/users/src/shared/metrics/business-metrics.ts` | periodic gauge poller |
| Orders | `services/orders/src/Orders.Infrastructure/Metrics/CloudWatchMetricsPublisher.cs` | `IMetricsPublisher` implementation |
| Orders | `services/orders/src/Orders.Application/Abstractions/IMetricsPublisher.cs` | the port |
| Orders | `services/orders/src/Orders.Api/BackgroundServices/OrdersMetricsPublisher.cs` | `BackgroundService` gauge poller |
| Tracking | `services/tracking/src/shared/metrics/cloudwatch_metrics.py` | boto3 publisher + Protocol port |
| Tracking | `services/tracking/src/features/tracking/commands/publish_metrics.py` | periodic gauge loop |
| events-pipeline | `functions/events-pipeline/src/shared/metrics/cloudwatch-metrics.ts` | counter publisher (buffered per invocation) |
| infra | `observability/otel-collector-config.yaml` (modify) | the `metrics` receiver block + pipeline |

Each publisher has ONE responsibility: turn a (name, value, dimensions) triple into a
`PutMetricData` call, log-and-swallow on failure. The gauge pollers own the *scheduling* and the
*queries*, never the SDK. That split is what makes the publishers unit-testable with a recording
double and the pollers testable with an injected fake clock.

## Task Order and Dependencies

```
Task 1 (collector config)  ──────────────┐
Task 2 (Users publisher+counters) ───────┤
Task 3 (Users gauges) ── depends on 2    │
Task 4 (Orders publisher+gauge) ─────────┼──> Task 9 (dashboards) depends on ALL
Task 5 (Tracking publisher+gauge) ───────┤
Task 6 (events-pipeline counters) ───────┤
Task 7 (HTTP error metrics, 3 services) ─┤
Task 8 (IAM + env wiring) ───────────────┘
```

Tasks 2–7 are independent of each other and may run in any order or in parallel. Task 8 (IAM
policy for the Lambda) is required before the events-pipeline's metrics reach Floci at runtime,
but not before its unit tests pass. Task 9 needs everything.

---

### Task 1: Collector metrics pipeline

**Files:**
- Modify: `observability/otel-collector-config.yaml` (receivers block ~line 22, service pipelines ~line 220)

**Interfaces:**
- Consumes: nothing (infrastructure-only).
- Produces: a running metrics pipeline that scrapes namespace `3MRAI` and exports to OpenObserve's
  `metrics` stream. Later tasks' metrics become visible once their names are added to `queries`.

- [ ] **Step 1: Add the metrics block to the existing `aws_cloudwatch` receiver**

In `observability/otel-collector-config.yaml`, the receiver currently has only `region` and
`logs`. Add a sibling `metrics` key (do NOT touch the `logs` block):

```yaml
  aws_cloudwatch:
    region: ${env:AWS_REGION}
    logs:
      poll_interval: 1m
      groups:
        autodiscover:
          limit: 50
          prefix: /ecs/
    # Metrics via GetMetricData. Same receiver, same credentials, separate signal.
    metrics:
      # LOCAL values. Real AWS uses 60s/60s and the default 10m delay — see the
      # design spec's "Polling intervals".
      collection_interval: 15s   # MUST be >= period; the receiver validates this at startup
                                 # and refuses to boot otherwise (a loud failure, by design).
      period: 15s
      # LOCAL ONLY, and load-bearing. The default is 10m, which compensates for real
      # CloudWatch's publication latency. Floci has none, so the default would make
      # NOTHING appear for the first ten minutes — indistinguishable from a broken
      # pipeline. Do not remove this line locally.
      delay: 0s
      queries:
        # `dimensions` is a MAP here ({Service: users}), NOT the AWS CLI's
        # list-of-{Name,Value}. And every query MUST name the exact dimension set the
        # metric was published with: Floci does not aggregate across dimensions and
        # returns an EMPTY result with StatusCode "Complete" when they do not match.
        - namespace: "3MRAI"
          metric_name: "users_registered_total"
          dimensions: { Service: users }
          stats: [Sum]
        - namespace: "3MRAI"
          metric_name: "password_resets_total"
          dimensions: { Service: users }
          stats: [Sum]
        - namespace: "3MRAI"
          metric_name: "users_total"
          dimensions: { Service: users, HasPassword: "true" }
          stats: [Maximum]
        - namespace: "3MRAI"
          metric_name: "users_total"
          dimensions: { Service: users, HasPassword: "false" }
          stats: [Maximum]
        - namespace: "3MRAI"
          metric_name: "orders_total"
          dimensions: { Service: orders }
          stats: [Maximum]
        - namespace: "3MRAI"
          metric_name: "orders_by_tracking_status_total"
          dimensions: { Service: tracking, Status: DELIVERED }
          stats: [Maximum]
        - namespace: "3MRAI"
          metric_name: "orders_by_tracking_status_total"
          dimensions: { Service: tracking, Status: IN_PROGRESS }
          stats: [Maximum]
        - namespace: "3MRAI"
          metric_name: "emails_sent_total"
          dimensions: { Service: events-pipeline, EmailType: ALL }
          stats: [Sum]
        - namespace: "3MRAI"
          metric_name: "emails_failed_total"
          dimensions: { Service: events-pipeline, EmailType: ALL, FailureKind: permanent }
          stats: [Sum]
        - namespace: "3MRAI"
          metric_name: "emails_failed_total"
          dimensions: { Service: events-pipeline, EmailType: ALL, FailureKind: transient }
          stats: [Sum]
        - namespace: "3MRAI"
          metric_name: "http_errors_total"
          dimensions: { Service: users, StatusClass: 4xx }
          stats: [Sum]
        - namespace: "3MRAI"
          metric_name: "http_errors_total"
          dimensions: { Service: users, StatusClass: 5xx }
          stats: [Sum]
        - namespace: "3MRAI"
          metric_name: "http_errors_total"
          dimensions: { Service: orders, StatusClass: 4xx }
          stats: [Sum]
        - namespace: "3MRAI"
          metric_name: "http_errors_total"
          dimensions: { Service: orders, StatusClass: 5xx }
          stats: [Sum]
        - namespace: "3MRAI"
          metric_name: "http_errors_total"
          dimensions: { Service: tracking, StatusClass: 4xx }
          stats: [Sum]
        - namespace: "3MRAI"
          metric_name: "http_errors_total"
          dimensions: { Service: tracking, StatusClass: 5xx }
          stats: [Sum]
```

> **Gauges use `stats: [Maximum]`, counters use `stats: [Sum]`.** A gauge published once per
> 15s window has exactly one sample, so Maximum returns that sample's value. `Sum` on a gauge
> would ADD every sample in the window — with two publishes landing in one window, `orders_total`
> would report double the real count. This is the single easiest way to produce a plausible wrong
> number here.

**Per-type email series are deliberately NOT listed above.** Nine template keys × sent/failed ×
two failure kinds is a long list that would need editing every time a template is added. Task 9
decides whether to add them explicitly or switch that metric to `discovery`. The `EmailType=ALL`
series is what the dashboards need first.

- [ ] **Step 2: Add the OpenObserve metrics exporter**

Add alongside the existing exporters (do not modify the log ones):

```yaml
  # Metrics to OpenObserve, its own stream — the same instance and auth as logs,
  # differing only in the stream-name header, exactly like the sql split above.
  # Unlike TRACES (see ADR-0019), OpenObserve's METRICS ingest accepts the
  # collector's batches: verified end to end, the stream is created and the data
  # points are queryable.
  otlp_http/openobserve_metrics:
    endpoint: http://openobserve:5080/api/default
    headers:
      Authorization: "Basic ${env:O2_BASIC_AUTH}"
      stream-name: metrics
```

- [ ] **Step 3: Add the metrics pipeline**

Under `service.pipelines`, alongside `logs`, `logs/sql` and `traces`:

```yaml
    # CloudWatch metrics -> OpenObserve. No transform/parse_body: metrics arrive
    # already structured, like traces and unlike the stdout log path.
    metrics:
      receivers: [aws_cloudwatch]
      processors: [batch]
      exporters: [otlp_http/openobserve_metrics]
```

- [ ] **Step 4: Verify the collector starts and the config is valid**

```bash
docker run --rm -v "$PWD/observability/otel-collector-config.yaml:/etc/otel/config.yaml:ro" \
  -e AWS_REGION=us-east-1 -e O2_BASIC_AUTH=dGVzdDp0ZXN0 \
  otel/opentelemetry-collector-contrib:0.156.0 --config /etc/otel/config.yaml 2>&1 | head -20
```

Expected: `Everything is ready. Begin running and processing data.` and NO
`cannot unmarshal the configuration` / `invalid configuration` line. It will then log AWS
connection errors because Floci is not reachable from this bare container — that is expected and
not a config failure. Ctrl-C to stop.

- [ ] **Step 5: Verify end to end against Floci**

```bash
make bootstrap                       # if the stack is not already up
make observability-up
export AWS_ENDPOINT_URL=http://localhost:4566 AWS_DEFAULT_REGION=us-east-1 \
       AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
aws cloudwatch put-metric-data --namespace 3MRAI --metric-data \
  '[{"MetricName":"orders_total","Value":7,"Unit":"Count","Dimensions":[{"Name":"Service","Value":"orders"}]}]'
sleep 40   # >= 2 collection_intervals: one window can pass or fail on alignment alone
curl -s -X POST -H "Authorization: Basic $(printf 'admin@3mrai.local:Complexpass#123' | base64)" \
  -H "Content-Type: application/json" \
  "http://localhost:5080/api/default/_search?type=metrics" \
  -d '{"query":{"sql":"SELECT * FROM \"amazonaws_com_3mrai_orders_total\" LIMIT 5","start_time":0,"end_time":9999999999999999,"from":0,"size":5}}'
```

Expected: a JSON body whose `hits` array is **non-empty**, containing `"value": 7.0`,
`"metricname": "orders_total"` and `"dimensions_service": "orders"`. An empty `hits` array is a
FAILURE even though the HTTP status is 200 — that is the silent-empty mode this whole design
guards against.

- [ ] **Step 6: Commit**

```bash
git add observability/otel-collector-config.yaml
git commit -m "feat(infra): scrape CloudWatch metrics into OpenObserve"
```

---

### Task 2: Users — metrics publisher and event counters

**Files:**
- Create: `services/users/src/shared/metrics/cloudwatch-metrics.ts`
- Create: `services/users/tests/shared/metrics/cloudwatch-metrics.test.ts`
- Modify: `services/users/package.json` (add `@aws-sdk/client-cloudwatch`)
- Modify: `services/users/src/shared/di/awilix-container.ts` (Cradle interface ~L31-55, `registerSingletons` ~L74)
- Modify: `services/users/src/features/users/commands/register.ts` (~L189, after the success log)
- Modify: `services/users/src/features/users/commands/register-passwordless.ts` (success log)
- Modify: `services/users/src/features/users/commands/confirm-password-reset.ts` (~L130)

**Interfaces:**
- Consumes: `Env` from `#shared/config/env` (`AWS_REGION`, `AWS_ENDPOINT_URL` — both already exist).
- Produces:
  - `class MetricsPublisher` with
    `async publish(name: string, value: number, dimensions: Record<string, string>, unit?: string): Promise<void>`
    — never throws.
  - Cradle key `metricsPublisher: MetricsPublisher` (SINGLETON).
  - Metric `users_registered_total` (`Service=users`), `password_resets_total` (`Service=users`).

- [ ] **Step 1: Add the dependency**

```bash
cd services/users && nvm use && pnpm add @aws-sdk/client-cloudwatch@^3.1075.0
```

Pin the same major/minor line as the existing `@aws-sdk/client-sqs` and
`@aws-sdk/client-cognito-identity-provider` (both `^3.1075.0`).

- [ ] **Step 2: Write the failing test**

Create `services/users/tests/shared/metrics/cloudwatch-metrics.test.ts`. Mirrors the existing
`tests/shared/messaging/sqs-event-publisher.test.ts` style — a hand-built double passed into the
class, no Awilix:

```ts
import { describe, it, expect, vi } from "vitest";
import { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";

function makeClient(sendImpl?: () => Promise<unknown>) {
  return { send: vi.fn(sendImpl ?? (async () => ({}))) };
}

describe("MetricsPublisher", () => {
  it("sends one datum with the 3MRAI namespace and the given dimensions", async () => {
    const client = makeClient();
    const publisher = new MetricsPublisher({ client: client as any });

    await publisher.publish("users_registered_total", 1, { Service: "users" });

    expect(client.send).toHaveBeenCalledTimes(1);
    const input = (client.send.mock.calls[0][0] as any).input;
    expect(input.Namespace).toBe("3MRAI");
    expect(input.MetricData).toHaveLength(1);
    expect(input.MetricData[0].MetricName).toBe("users_registered_total");
    expect(input.MetricData[0].Value).toBe(1);
    expect(input.MetricData[0].Unit).toBe("Count");
    // Dimensions travel as CloudWatch's list-of-{Name,Value}, and the exact set
    // matters: Floci returns an EMPTY result for a query whose dimensions differ.
    expect(input.MetricData[0].Dimensions).toEqual([{ Name: "Service", Value: "users" }]);
  });

  it("never throws when the client fails — a metric must not break the caller", async () => {
    const client = makeClient(async () => {
      throw new Error("CloudWatch is down");
    });
    const publisher = new MetricsPublisher({ client: client as any });

    await expect(
      publisher.publish("users_registered_total", 1, { Service: "users" }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
cd services/users && nvm use && npx vitest run tests/shared/metrics/cloudwatch-metrics.test.ts
```

Expected: FAIL — `Cannot find module '#shared/metrics/cloudwatch-metrics'`.

- [ ] **Step 4: Implement the publisher**

Create `services/users/src/shared/metrics/cloudwatch-metrics.ts`. Note this file lives under
`src/shared/`, where the house style is **relative imports with an explicit `.ts`** (see
`awilix-container.ts` importing `"../config/env.ts"`), not the `#shared/` prefix:

```ts
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { appLogger } from "../logging/app-logger.ts";

/** The one namespace every 3MRAI metric is published under. */
export const METRICS_NAMESPACE = "3MRAI";

/**
 * Publishes custom metrics to CloudWatch.
 *
 * Every failure is logged and swallowed. A metrics backend being unreachable must
 * never fail the registration, login or password reset that triggered the metric —
 * the same stance SqsEventPublisher takes for events.
 */
export class MetricsPublisher {
  private readonly client: CloudWatchClient;

  constructor({ client }: { client: CloudWatchClient }) {
    this.client = client;
  }

  async publish(
    name: string,
    value: number,
    dimensions: Record<string, string>,
    unit: "Count" | "Milliseconds" = "Count",
  ): Promise<void> {
    try {
      await this.client.send(
        new PutMetricDataCommand({
          Namespace: METRICS_NAMESPACE,
          MetricData: [
            {
              MetricName: name,
              Value: value,
              Unit: unit,
              Dimensions: Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value })),
            },
          ],
        }),
      );
    } catch (err) {
      // Swallowed on purpose — see the class docstring.
      appLogger.warn(
        {
          app_event: "metric_publish_failed",
          reason: err instanceof Error ? err.message : String(err),
          metric_name: name,
        },
        "failed to publish metric",
      );
    }
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
cd services/users && nvm use && npx vitest run tests/shared/metrics/cloudwatch-metrics.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 6: Register in the Awilix container**

In `services/users/src/shared/di/awilix-container.ts`:

Add to the `Cradle` interface (the `declare module "@fastify/awilix"` block, ~L31-55):

```ts
    cloudwatchClient: CloudWatchClient;
    metricsPublisher: MetricsPublisher;
```

Add the imports at the top, matching the file's relative-path style:

```ts
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { MetricsPublisher } from "../metrics/cloudwatch-metrics.ts";
```

Add to `registerSingletons()` (~L74), mirroring the `sqsClient` registration exactly:

```ts
    cloudwatchClient: asFunction(
      ({ env: cradleEnv }: { env: Env }) =>
        new CloudWatchClient({
          region: cradleEnv.AWS_REGION,
          endpoint: cradleEnv.AWS_ENDPOINT_URL,
        }),
      { lifetime: Lifetime.SINGLETON },
    ),
    metricsPublisher: asClass(MetricsPublisher, { lifetime: Lifetime.SINGLETON }),
```

- [ ] **Step 7: Emit the counters at the three success points**

`register.ts` — inject `metricsPublisher` into the constructor destructuring (~L34) and add
after the `register_succeeded` log (~L189), before `return toDomain(...)`:

```ts
    // Fire-and-forget: awaited so a slow CloudWatch shows up in the request's own
    // duration rather than as an unhandled rejection after the response. The call
    // itself never throws (see MetricsPublisher).
    await this.metrics.publish("users_registered_total", 1, { Service: "users" });
```

Do the same in `register-passwordless.ts` after its success log — **the same metric name and the
same dimensions**. Both are registrations; the password/passwordless split is carried by
`users_total`'s `HasPassword` dimension (Task 3), not by a second counter.

`confirm-password-reset.ts` — after the `password_reset_confirm_succeeded` log (~L130):

```ts
    await this.metrics.publish("password_resets_total", 1, { Service: "users" });
```

> Emit on **confirm**, not on request. `forgot-password.ts` succeeds even for an unknown email
> (deliberate non-enumeration), so counting requests would count resets that never happened.

- [ ] **Step 8: Add a test asserting register emits the counter**

Append to `services/users/tests/features/users/commands/register.test.ts`, following that file's
existing `deps()` factory pattern:

```ts
it("publishes users_registered_total on success", async () => {
  const publish = vi.fn(async () => {});
  const d = deps({ metricsPublisher: { publish } });
  const cmd = new RegisterUserCommand(d as any);

  await cmd.execute({
    email: "ada@example.com",
    password: "Complexpass#123",
    fullName: "Ada Lovelace",
    e2eSource: false,
  });

  expect(publish).toHaveBeenCalledWith("users_registered_total", 1, { Service: "users" });
});
```

You must also add `metricsPublisher: { publish: vi.fn(async () => {}) }` to the `deps()` factory's
defaults in that file, or every other test in it breaks with "cannot read property publish of
undefined".

- [ ] **Step 9: Run the full Users suite**

```bash
cd services/users && nvm use && npm test
```

Expected: PASS, including the pre-existing tests. If tests fail with a missing-env error, add any
new var to the `test.env` block in `services/users/vitest.config.ts` — but this task adds none
(`AWS_REGION` and `AWS_ENDPOINT_URL` already exist there).

- [ ] **Step 10: Commit**

```bash
git add services/users
git commit -m "feat(users): publish registration and password-reset metrics to CloudWatch"
```

---

### Task 3: Users — periodic gauge for users with/without password

**Files:**
- Create: `services/users/src/shared/metrics/business-metrics.ts`
- Create: `services/users/tests/shared/metrics/business-metrics.test.ts`
- Modify: `services/users/src/shared/di/awilix-container.ts` (Cradle + `registerSingletons`)
- Modify: `services/users/src/server.ts` (start the poller after `app.listen`, ~L27)
- Modify: `services/users/src/shared/config/env.ts` (add `METRICS_INTERVAL_MS`)
- Modify: `services/users/vitest.config.ts` (`test.env` — add the new var)

**Interfaces:**
- Consumes: `MetricsPublisher` (Task 2), `Db` (the Prisma client from the cradle), `Env`.
- Produces:
  - `class BusinessMetricsPoller` with `start(): void`, `stop(): void`, and
    `async collectAndPublish(): Promise<void>` (exposed so tests drive one tick without timers).
  - Metric `users_total` with `Service=users` + `HasPassword=true|false`.

- [ ] **Step 1: Add the interval env var**

In `services/users/src/shared/config/env.ts`, add to the Zod schema (the service uses Zod per
[[ADR-0014-env-validation-zod]]):

```ts
  // 15s locally; real AWS uses 60s. Defaulted so no existing env file, test, or
  // deployment breaks by omitting it.
  METRICS_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
```

Add the same key to the `test.env` block in `services/users/vitest.config.ts`:

```ts
      METRICS_INTERVAL_MS: "15000",
```

- [ ] **Step 2: Write the failing test**

Create `services/users/tests/shared/metrics/business-metrics.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { BusinessMetricsPoller } from "#shared/metrics/business-metrics";

function makeDeps(counts: { password: number; passwordless: number }) {
  const publish = vi.fn(async () => {});
  const db = {
    user: {
      count: vi.fn(async ({ where }: any) =>
        where.authType === "PASSWORD" ? counts.password : counts.passwordless,
      ),
    },
  };
  return { publish, db, metricsPublisher: { publish }, env: { METRICS_INTERVAL_MS: 15_000 } };
}

describe("BusinessMetricsPoller", () => {
  it("publishes one users_total series per HasPassword value", async () => {
    const d = makeDeps({ password: 7, passwordless: 3 });
    const poller = new BusinessMetricsPoller(d as any);

    await poller.collectAndPublish();

    expect(d.publish).toHaveBeenCalledWith("users_total", 7, {
      Service: "users",
      HasPassword: "true",
    });
    expect(d.publish).toHaveBeenCalledWith("users_total", 3, {
      Service: "users",
      HasPassword: "false",
    });
  });

  it("excludes soft-deleted users from both counts", async () => {
    const d = makeDeps({ password: 1, passwordless: 1 });
    const poller = new BusinessMetricsPoller(d as any);

    await poller.collectAndPublish();

    for (const call of d.db.user.count.mock.calls) {
      expect((call[0] as any).where.deletedAt).toBeNull();
    }
  });

  it("never throws when the database query fails", async () => {
    const d = makeDeps({ password: 0, passwordless: 0 });
    d.db.user.count = vi.fn(async () => {
      throw new Error("db down");
    });
    const poller = new BusinessMetricsPoller(d as any);

    await expect(poller.collectAndPublish()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
cd services/users && nvm use && npx vitest run tests/shared/metrics/business-metrics.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement the poller**

Create `services/users/src/shared/metrics/business-metrics.ts`:

```ts
import type { Db } from "../db/prisma.ts";
import type { Env } from "../config/env.ts";
import { appLogger } from "../logging/app-logger.ts";
import type { MetricsPublisher } from "./cloudwatch-metrics.ts";

/**
 * Periodically publishes gauge metrics describing the CURRENT state of the users
 * table.
 *
 * These are gauges, not counters, on purpose: "how many users have no password"
 * is a question about state. A counter would have to decrement when a user sets
 * one, which counters cannot do, and would drift from the database with no way to
 * explain the difference.
 */
export class BusinessMetricsPoller {
  private readonly db: Db;
  private readonly metrics: MetricsPublisher;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;

  constructor({
    db,
    metricsPublisher,
    env,
  }: {
    db: Db;
    metricsPublisher: MetricsPublisher;
    env: Env;
  }) {
    this.db = db;
    this.metrics = metricsPublisher;
    this.intervalMs = env.METRICS_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    // unref() so a pending timer never holds the process open at shutdown.
    this.timer = setInterval(() => {
      void this.collectAndPublish();
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One tick. Public so tests can drive it without waiting on a timer. */
  async collectAndPublish(): Promise<void> {
    try {
      // Two counts rather than a groupBy: a groupBy omits rows for a value with no
      // users at all, which would silently stop publishing that series instead of
      // publishing a 0 — and a series that stops updating reads as "no data" in a
      // dashboard, not as "zero".
      const withPassword = await this.db.user.count({
        where: { authType: "PASSWORD", deletedAt: null },
      });
      const withoutPassword = await this.db.user.count({
        where: { authType: "PASSWORDLESS", deletedAt: null },
      });

      await this.metrics.publish("users_total", withPassword, {
        Service: "users",
        HasPassword: "true",
      });
      await this.metrics.publish("users_total", withoutPassword, {
        Service: "users",
        HasPassword: "false",
      });
    } catch (err) {
      appLogger.warn(
        {
          app_event: "metrics_collection_failed",
          reason: err instanceof Error ? err.message : String(err),
        },
        "failed to collect business metrics",
      );
    }
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
cd services/users && nvm use && npx vitest run tests/shared/metrics/business-metrics.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Register and start the poller**

In `awilix-container.ts`, add to the `Cradle` interface and to `registerSingletons()`:

```ts
    businessMetricsPoller: asClass(BusinessMetricsPoller, { lifetime: Lifetime.SINGLETON }),
```

In `services/users/src/server.ts`, after `await app.listen(...)` and near the existing
`app.diContainer.resolve("userQueryService")` call (~L22):

```ts
// Started here, not in buildApp(): buildApp is also called by the test suite, and a
// live 15s timer in every test run would hit the database from outside any test's
// control. server.ts runs only for the real process.
const businessMetricsPoller = app.diContainer.resolve("businessMetricsPoller");
businessMetricsPoller.start();
```

Add the stop to the existing SIGTERM handler in `src/shared/observability/tracing.ts:58`, or
add one in `server.ts` next to the start:

```ts
process.on("SIGTERM", () => {
  businessMetricsPoller.stop();
});
```

- [ ] **Step 7: Run the full suite and typecheck**

```bash
cd services/users && nvm use && npm test && npx tsc --noEmit
```

Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add services/users
git commit -m "feat(users): publish users_total gauge by password type"
```

---

### Task 4: Orders — metrics publisher and orders_total gauge

**Files:**
- Create: `services/orders/src/Orders.Application/Abstractions/IMetricsPublisher.cs`
- Create: `services/orders/src/Orders.Infrastructure/Metrics/CloudWatchMetricsPublisher.cs`
- Create: `services/orders/src/Orders.Infrastructure/Metrics/NoopMetricsPublisher.cs`
- Create: `services/orders/src/Orders.Api/BackgroundServices/OrdersMetricsPublisher.cs`
- Create: `services/orders/tests/Orders.Tests/Metrics/CloudWatchMetricsPublisherTests.cs`
- Modify: `services/orders/src/Orders.Infrastructure/Orders.Infrastructure.csproj` (add `AWSSDK.CloudWatch`)
- Modify: `services/orders/src/Orders.Api/Program.cs` (DI block, lines 69–217)

**Interfaces:**
- Consumes: `OrdersReadDbContext` (`Orders.Infrastructure.Persistence`), `IAmazonCloudWatch`.
- Produces:
  - `interface IMetricsPublisher { Task PublishAsync(string name, double value, IReadOnlyDictionary<string,string> dimensions, CancellationToken ct = default); }`
    in namespace `Orders.Application.Abstractions`.
  - Metric `orders_total` (`Service=orders`).

- [ ] **Step 1: Add the NuGet package**

In `services/orders/src/Orders.Infrastructure/Orders.Infrastructure.csproj`, beside the existing
`AWSSDK.SQS`:

```xml
    <PackageReference Include="AWSSDK.CloudWatch" Version="4.0.100.7" />
```

Match the **v4 SDK line** the existing `AWSSDK.SQS` uses — mixing v3 and v4 AWS SDK packages in
one project causes assembly-binding conflicts.

- [ ] **Step 2: Write the failing test**

Create `services/orders/tests/Orders.Tests/Metrics/CloudWatchMetricsPublisherTests.cs`, modelled
on the existing `tests/Orders.Tests/Messaging/SqsEventPublisherTests.cs`:

```csharp
using Amazon.CloudWatch;
using Amazon.CloudWatch.Model;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Orders.Infrastructure.Metrics;

namespace Orders.Tests.Metrics;

public class CloudWatchMetricsPublisherTests
{
    [Fact]
    public async Task PublishAsync_SendsOneDatumInThe3mraiNamespace()
    {
        PutMetricDataRequest? captured = null;
        var client = new Mock<IAmazonCloudWatch>();
        client
            .Setup(c => c.PutMetricDataAsync(It.IsAny<PutMetricDataRequest>(), It.IsAny<CancellationToken>()))
            .Callback<PutMetricDataRequest, CancellationToken>((r, _) => captured = r)
            .ReturnsAsync(new PutMetricDataResponse());

        var publisher = new CloudWatchMetricsPublisher(
            client.Object, NullLogger<CloudWatchMetricsPublisher>.Instance);

        await publisher.PublishAsync("orders_total", 42, new Dictionary<string, string>
        {
            ["Service"] = "orders",
        });

        Assert.NotNull(captured);
        Assert.Equal("3MRAI", captured!.Namespace);
        var datum = Assert.Single(captured.MetricData);
        Assert.Equal("orders_total", datum.MetricName);
        Assert.Equal(42, datum.Value);
        var dimension = Assert.Single(datum.Dimensions);
        Assert.Equal("Service", dimension.Name);
        Assert.Equal("orders", dimension.Value);
    }

    [Fact]
    public async Task PublishAsync_SwallowsClientFailures()
    {
        var client = new Mock<IAmazonCloudWatch>();
        client
            .Setup(c => c.PutMetricDataAsync(It.IsAny<PutMetricDataRequest>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new AmazonCloudWatchException("CloudWatch is down"));

        var publisher = new CloudWatchMetricsPublisher(
            client.Object, NullLogger<CloudWatchMetricsPublisher>.Instance);

        // Must not throw: a metric failure may never break the caller.
        await publisher.PublishAsync("orders_total", 1, new Dictionary<string, string>
        {
            ["Service"] = "orders",
        });
    }
}
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
cd services/orders && dotnet test --filter FullyQualifiedName~CloudWatchMetricsPublisherTests
```

Expected: FAIL to compile — `CloudWatchMetricsPublisher` does not exist.

- [ ] **Step 4: Write the port and the implementation**

`services/orders/src/Orders.Application/Abstractions/IMetricsPublisher.cs`:

```csharp
namespace Orders.Application.Abstractions;

/// <summary>
/// Publishes a custom business metric.
/// </summary>
/// <remarks>
/// Implementations MUST NOT throw. A metrics backend being unreachable may never fail
/// the operation that produced the metric — the same stance <see cref="IEventPublisher"/>
/// takes. The port lives in Application; the CloudWatch implementation lives in
/// Infrastructure, per the dependency-direction rule in this service's CLAUDE.md §3.
/// </remarks>
public interface IMetricsPublisher
{
    Task PublishAsync(
        string name,
        double value,
        IReadOnlyDictionary<string, string> dimensions,
        CancellationToken cancellationToken = default);
}
```

`services/orders/src/Orders.Infrastructure/Metrics/CloudWatchMetricsPublisher.cs`:

```csharp
using Amazon.CloudWatch;
using Amazon.CloudWatch.Model;
using Microsoft.Extensions.Logging;
using Orders.Application.Abstractions;

namespace Orders.Infrastructure.Metrics;

public class CloudWatchMetricsPublisher : IMetricsPublisher
{
    /// <summary>The one namespace every 3MRAI metric is published under.</summary>
    public const string MetricsNamespace = "3MRAI";

    private readonly IAmazonCloudWatch _client;
    private readonly ILogger<CloudWatchMetricsPublisher> _logger;

    public CloudWatchMetricsPublisher(
        IAmazonCloudWatch client,
        ILogger<CloudWatchMetricsPublisher> logger)
    {
        _client = client;
        _logger = logger;
    }

    public async Task PublishAsync(
        string name,
        double value,
        IReadOnlyDictionary<string, string> dimensions,
        CancellationToken cancellationToken = default)
    {
        try
        {
            await _client.PutMetricDataAsync(
                new PutMetricDataRequest
                {
                    Namespace = MetricsNamespace,
                    MetricData =
                    [
                        new MetricDatum
                        {
                            MetricName = name,
                            Value = value,
                            Unit = StandardUnit.Count,
                            Dimensions = dimensions
                                .Select(d => new Dimension { Name = d.Key, Value = d.Value })
                                .ToList(),
                        },
                    ],
                },
                cancellationToken);
        }
        catch (Exception ex)
        {
            // Swallowed on purpose — see IMetricsPublisher's remarks.
            _logger.LogWarning(
                ex,
                "{app_event} metric={metric_name} reason={reason}",
                "metric_publish_failed",
                name,
                ex.Message);
        }
    }
}
```

`services/orders/src/Orders.Infrastructure/Metrics/NoopMetricsPublisher.cs` — the test binding,
mirroring the existing `NoopEventPublisher`:

```csharp
using Orders.Application.Abstractions;

namespace Orders.Infrastructure.Metrics;

/// <summary>No-op binding for suites that must not reach CloudWatch.</summary>
public class NoopMetricsPublisher : IMetricsPublisher
{
    public Task PublishAsync(
        string name,
        double value,
        IReadOnlyDictionary<string, string> dimensions,
        CancellationToken cancellationToken = default) => Task.CompletedTask;
}
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
cd services/orders && dotnet test --filter FullyQualifiedName~CloudWatchMetricsPublisherTests
```

Expected: PASS, 2 tests.

- [ ] **Step 6: Write the BackgroundService gauge**

Create `services/orders/src/Orders.Api/BackgroundServices/OrdersMetricsPublisher.cs`. This is the
service's **first** `BackgroundService` — there are none today:

```csharp
using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Infrastructure.Persistence;

namespace Orders.Api.BackgroundServices;

/// <summary>
/// Periodically publishes <c>orders_total</c> — the true count of live orders.
///
/// A gauge, not a counter: it reports current state, and it is what makes the
/// Orders-to-Tracking gap visible. Tracking publishes DELIVERED + IN_PROGRESS
/// counts of orders that HAVE a tracking row; the difference against this number
/// is exactly the set of orders whose init-tracking call failed (see
/// TrackingInitResult's remarks). In normal operation the difference is zero.
/// </summary>
public class OrdersMetricsPublisher : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IMetricsPublisher _metrics;
    private readonly ILogger<OrdersMetricsPublisher> _logger;
    private readonly TimeSpan _interval;

    public OrdersMetricsPublisher(
        IServiceScopeFactory scopeFactory,
        IMetricsPublisher metrics,
        ILogger<OrdersMetricsPublisher> logger,
        IConfiguration configuration)
    {
        _scopeFactory = scopeFactory;
        _metrics = metrics;
        _logger = logger;
        // 15s locally, 60s in real AWS. Defaulted so no env file breaks by omitting it.
        _interval = TimeSpan.FromMilliseconds(
            configuration.GetValue<int?>("METRICS_INTERVAL_MS") ?? 15_000);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(_interval);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                // OrdersReadDbContext is registered SCOPED, so a singleton hosted
                // service must open its own scope per tick.
                using var scope = _scopeFactory.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<OrdersReadDbContext>();

                // The global query filter (o => o.DeletedAt == null) applies
                // automatically — no Where() needed, and never filter on IsDeleted,
                // which is a computed property EF cannot translate.
                var total = await db.Orders.AsNoTracking().CountAsync(stoppingToken);

                await _metrics.PublishAsync(
                    "orders_total",
                    total,
                    new Dictionary<string, string> { ["Service"] = "orders" },
                    stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;   // normal shutdown
            }
            catch (Exception ex)
            {
                // Swallow and keep ticking: one bad tick must not kill the loop.
                _logger.LogWarning(
                    ex, "{app_event} reason={reason}", "metrics_collection_failed", ex.Message);
            }
        }
    }
}
```

- [ ] **Step 7: Register everything in Program.cs**

In the DI block (lines 69–217), beside the existing `IAmazonSQS` registration, copying its
endpoint-override pattern exactly:

```csharp
builder.Services.AddSingleton<IAmazonCloudWatch>(_ =>
{
    var config = new AmazonCloudWatchConfig
    {
        RegionEndpoint = Amazon.RegionEndpoint.GetBySystemName(
            builder.Configuration["AWS_REGION"] ?? "us-east-1"),
    };
    var endpointUrl = builder.Configuration["AWS_ENDPOINT_URL"];
    if (!string.IsNullOrWhiteSpace(endpointUrl))
    {
        config.ServiceURL = endpointUrl;
    }
    return new AmazonCloudWatchClient(config);
});

builder.Services.AddSingleton<IMetricsPublisher>(sp => new CloudWatchMetricsPublisher(
    sp.GetRequiredService<IAmazonCloudWatch>(),
    sp.GetRequiredService<ILogger<CloudWatchMetricsPublisher>>()));

// Skipped during build-time OpenAPI generation: GetDocument.Insider builds the app
// to read its endpoint metadata, and a hosted service would start a real timer and
// hit a database that is not there.
if (!isDocumentGeneration)
{
    builder.Services.AddHostedService<OrdersMetricsPublisher>();
}
```

`isDocumentGeneration` already exists at Program.cs:126–133 — reuse that local, do not redeclare
it. Add `using Amazon.CloudWatch;`, `using Orders.Api.BackgroundServices;`,
`using Orders.Infrastructure.Metrics;` at the top.

- [ ] **Step 8: Stop the hosted service reaching CloudWatch in tests**

In `services/orders/tests/Orders.Tests/Api/OrdersApiFactory.cs`, inside the existing
`builder.ConfigureTestServices(...)` block, swap the publisher for the no-op using the same
Single/Remove/re-add idiom already used for `IEventPublisher`:

```csharp
            var metricsDescriptor = services.SingleOrDefault(
                d => d.ServiceType == typeof(IMetricsPublisher));
            if (metricsDescriptor is not null)
            {
                services.Remove(metricsDescriptor);
            }
            services.AddSingleton<IMetricsPublisher>(new NoopMetricsPublisher());
```

- [ ] **Step 9: Build and run the full suite**

```bash
cd services/orders && dotnet build && dotnet test
```

Expected: build succeeds (which also regenerates `openapi.yaml` — no routes changed, so it should
be unchanged; if it did change, commit it) and all tests pass.

- [ ] **Step 10: Commit**

```bash
git add services/orders
git commit -m "feat(orders): publish orders_total gauge to CloudWatch"
```

---

### Task 5: Tracking — metrics publisher and orders-by-status gauge

**Files:**
- Create: `services/tracking/src/shared/metrics/__init__.py`
- Create: `services/tracking/src/shared/metrics/cloudwatch_metrics.py`
- Create: `services/tracking/src/features/tracking/commands/publish_metrics.py`
- Create: `services/tracking/tests/test_cloudwatch_metrics.py`
- Create: `services/tracking/tests/test_publish_metrics.py`
- Modify: `services/tracking/src/shared/config/settings.py` (add `metrics_interval_seconds`)
- Modify: `services/tracking/src/main.py` (add a `lifespan` to `create_app`, ~L94)
- Modify: `services/tracking/tests/test_settings.py` (`MANAGED_KEYS`)

**Interfaces:**
- Consumes: `get_settings()`, `read_session` from `src.shared.db.engine`, `Tracking` model.
- Produces:
  - `class MetricsPublisher(Protocol)` with
    `def publish(self, name: str, value: float, dimensions: dict[str, str]) -> None`.
  - `def shared_metrics_publisher() -> CloudWatchMetricsPublisher` (lru_cached on primitives).
  - `async def run_metrics_publisher(*, interval, reader, publisher, sleep) -> None`.
  - Metric `orders_by_tracking_status_total` with `Service=tracking` + `Status=DELIVERED|IN_PROGRESS`.

- [ ] **Step 1: Add the setting**

In `services/tracking/src/shared/config/settings.py`, beside the existing `aws_endpoint_url` /
`aws_region` (lines 113–114):

```python
    # 15s locally; real AWS uses 60s. Defaulted, because every name in this class is
    # emitted into .env.local.tracking by generate_env_files.py and a required field
    # with no default would break startup for anyone who has not regenerated.
    metrics_interval_seconds: float = 15.0
```

Add `"METRICS_INTERVAL_SECONDS"` to `MANAGED_KEYS` in `services/tracking/tests/test_settings.py`
(line ~26), or that test fails.

- [ ] **Step 2: Write the failing publisher test**

Create `services/tracking/tests/test_cloudwatch_metrics.py`. Follows the house style of
`tests/test_sqs_event_publisher.py` — a hand-written recorder, deliberately not `unittest.mock`:

```python
"""Unit tests for the CloudWatch metrics publisher.

A hand-written recorder rather than unittest.mock, matching test_sqs_event_publisher.py:
the assertions are about the exact shape of the PutMetricData call, which a recorder
makes readable and a Mock hides behind call-args tuples.
"""

import pytest

from src.shared.metrics.cloudwatch_metrics import CloudWatchMetricsPublisher


class RecordingCloudWatchClient:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def put_metric_data(self, **kwargs) -> dict:
        self.calls.append(kwargs)
        return {}


class FailingCloudWatchClient:
    def put_metric_data(self, **kwargs) -> dict:
        raise RuntimeError("CloudWatch is down")


def test_publishes_one_datum_in_the_3mrai_namespace() -> None:
    client = RecordingCloudWatchClient()
    publisher = CloudWatchMetricsPublisher(client=client)

    publisher.publish(
        "orders_by_tracking_status_total",
        5,
        {"Service": "tracking", "Status": "DELIVERED"},
    )

    assert len(client.calls) == 1
    call = client.calls[0]
    assert call["Namespace"] == "3MRAI"
    assert len(call["MetricData"]) == 1
    datum = call["MetricData"][0]
    assert datum["MetricName"] == "orders_by_tracking_status_total"
    assert datum["Value"] == 5
    assert datum["Unit"] == "Count"
    # The exact dimension set matters: Floci returns an EMPTY result, not an error,
    # for a query whose dimensions differ from what was published.
    assert datum["Dimensions"] == [
        {"Name": "Service", "Value": "tracking"},
        {"Name": "Status", "Value": "DELIVERED"},
    ]


def test_never_raises_when_the_client_fails() -> None:
    publisher = CloudWatchMetricsPublisher(client=FailingCloudWatchClient())

    # Must not raise: a metric failure may never break the caller.
    publisher.publish("orders_by_tracking_status_total", 1, {"Service": "tracking"})
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
cd services/tracking && python -m pytest tests/test_cloudwatch_metrics.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'src.shared.metrics'`.

- [ ] **Step 4: Implement the publisher**

Create `services/tracking/src/shared/metrics/__init__.py` (empty) and
`services/tracking/src/shared/metrics/cloudwatch_metrics.py`:

```python
"""CloudWatch custom-metrics publisher.

Wiring mirrors shared/messaging/sqs_event_publisher.py: a Protocol port, a concrete
boto3-backed implementation, and an lru_cached factory keyed on PRIMITIVES (never on
Settings, which is unhashable). `shared/di/` in this service is an empty placeholder —
there is no framework container to register into.

Every failure is logged and swallowed. A metrics backend being unreachable must never
break the request or the loop that produced the metric.
"""

import logging
from functools import lru_cache
from typing import Any, Protocol

import boto3

from src.shared.config.settings import get_settings

logger = logging.getLogger(__name__)

#: The one namespace every 3MRAI metric is published under.
METRICS_NAMESPACE = "3MRAI"


class MetricsPublisher(Protocol):
    """Port. `publish` never raises."""

    def publish(self, name: str, value: float, dimensions: dict[str, str]) -> None: ...


class CloudWatchMetricsPublisher:
    """Publishes to CloudWatch via boto3. Blocking — call from asyncio.to_thread."""

    def __init__(self, *, client: Any) -> None:
        self._client = client

    def publish(self, name: str, value: float, dimensions: dict[str, str]) -> None:
        try:
            self._client.put_metric_data(
                Namespace=METRICS_NAMESPACE,
                MetricData=[
                    {
                        "MetricName": name,
                        "Value": value,
                        "Unit": "Count",
                        "Dimensions": [
                            {"Name": key, "Value": val} for key, val in dimensions.items()
                        ],
                    }
                ],
            )
        except Exception:  # noqa: BLE001 - swallowed on purpose, see the module docstring
            logger.exception(
                "failed to publish metric",
                extra={"app_event": "metric_publish_failed", "metric_name": name},
            )


class NoopMetricsPublisher:
    """Binding for suites that must not reach CloudWatch."""

    def publish(self, name: str, value: float, dimensions: dict[str, str]) -> None:
        return None


@lru_cache(maxsize=1)
def _cached_publisher(endpoint_url: str | None, region: str) -> CloudWatchMetricsPublisher:
    client = boto3.client("cloudwatch", endpoint_url=endpoint_url, region_name=region)
    return CloudWatchMetricsPublisher(client=client)


def shared_metrics_publisher() -> CloudWatchMetricsPublisher:
    settings = get_settings()
    return _cached_publisher(settings.aws_endpoint_url, settings.aws_region)
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
cd services/tracking && python -m pytest tests/test_cloudwatch_metrics.py -v
```

Expected: PASS, 2 tests.

- [ ] **Step 6: Write the failing gauge-loop test**

Create `services/tracking/tests/test_publish_metrics.py`:

```python
"""Unit tests for the periodic metrics loop.

No database and no CloudWatch: the session factory and the publisher are both
injected, and `sleep` is a fake, so the loop runs deterministically and instantly.
"""

import asyncio

import pytest

from src.features.tracking.commands.publish_metrics import collect_status_counts


class RecordingPublisher:
    def __init__(self) -> None:
        self.published: list[tuple[str, float, dict[str, str]]] = []

    def publish(self, name: str, value: float, dimensions: dict[str, str]) -> None:
        self.published.append((name, value, dimensions))


def test_collect_status_counts_splits_delivered_from_in_progress() -> None:
    # Raw per-status counts as the SQL GROUP BY would return them.
    raw = {"PLACED": 2, "SHIPPED": 3, "DELIVERED": 4}

    delivered, in_progress = collect_status_counts(raw)

    assert delivered == 4
    # Everything that is not DELIVERED is unfinished: 2 + 3.
    assert in_progress == 5


def test_collect_status_counts_reports_zero_rather_than_omitting_a_series() -> None:
    # No delivered trackings at all. The series must still be published as 0 —
    # a series that stops updating reads as "no data" in a dashboard, not as zero.
    delivered, in_progress = collect_status_counts({"PLACED": 1})

    assert delivered == 0
    assert in_progress == 1


def test_collect_status_counts_handles_an_empty_table() -> None:
    assert collect_status_counts({}) == (0, 0)
```

- [ ] **Step 7: Run it and confirm it fails**

```bash
cd services/tracking && python -m pytest tests/test_publish_metrics.py -v
```

Expected: FAIL — module not found.

- [ ] **Step 8: Implement the gauge loop**

Create `services/tracking/src/features/tracking/commands/publish_metrics.py`, mirroring
`test_mode_progression.py`'s structure (injected interval, injected sleep, `asyncio.to_thread`
for blocking DB work):

```python
"""Periodic publication of tracking-derived gauges.

Publishes `orders_by_tracking_status_total`, split into DELIVERED (finished orders)
and IN_PROGRESS (everything else). DELIVERED is the state machine's TERMINAL_STATUS,
so "finished" is the domain's own invariant rather than a convention invented here.

Counting trackings is counting orders: tracking.order_id carries a UNIQUE constraint,
so there is exactly one tracking per order and no double counting.

Structured like test_mode_progression: interval and sleep injected for tests, blocking
DB work offloaded with asyncio.to_thread. UNLIKE that module, a per-tick error is
swallowed and the loop CONTINUES — this loop never ends on its own.
"""

import asyncio
import logging
from collections.abc import Callable

from sqlalchemy import func, select

from src.features.tracking.domain.models import Tracking
from src.features.tracking.domain.status import TrackingStatus
from src.shared.db.engine import read_session
from src.shared.metrics.cloudwatch_metrics import MetricsPublisher, shared_metrics_publisher

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_SECONDS = 15.0


def collect_status_counts(raw: dict[str, int]) -> tuple[int, int]:
    """Split raw per-status counts into (delivered, in_progress).

    Pure, so the split is unit-testable without a database. Both values are always
    returned, 0 included: a series that stops being published reads as "no data" in a
    dashboard rather than as zero.
    """
    delivered = raw.get(TrackingStatus.DELIVERED.value, 0)
    in_progress = sum(
        count for status, count in raw.items() if status != TrackingStatus.DELIVERED.value
    )
    return delivered, in_progress


def _query_status_counts() -> dict[str, int]:
    """One GROUP BY over live trackings. Blocking — call via asyncio.to_thread."""
    with read_session() as session:
        stmt = (
            select(Tracking.status, func.count())
            .where(Tracking.deleted_at.is_(None))
            .group_by(Tracking.status)
        )
        return {status: count for status, count in session.execute(stmt).all()}


async def run_metrics_publisher(
    *,
    interval: float = DEFAULT_INTERVAL_SECONDS,
    publisher: MetricsPublisher | None = None,
    query: Callable[[], dict[str, int]] = _query_status_counts,
    sleep: Callable[[float], object] = asyncio.sleep,
) -> None:
    """Publish the gauges forever, one tick per `interval`."""
    resolved = publisher if publisher is not None else shared_metrics_publisher()

    try:
        while True:
            await sleep(interval)
            try:
                raw = await asyncio.to_thread(query)
                delivered, in_progress = collect_status_counts(raw)

                await asyncio.to_thread(
                    resolved.publish,
                    "orders_by_tracking_status_total",
                    delivered,
                    {"Service": "tracking", "Status": "DELIVERED"},
                )
                await asyncio.to_thread(
                    resolved.publish,
                    "orders_by_tracking_status_total",
                    in_progress,
                    {"Service": "tracking", "Status": "IN_PROGRESS"},
                )
            except Exception:  # noqa: BLE001 - one bad tick must not kill the loop
                logger.exception(
                    "failed to collect tracking metrics",
                    extra={"app_event": "metrics_collection_failed"},
                )
    except asyncio.CancelledError:
        logger.info(
            "metrics publisher cancelled",
            extra={"app_event": "metrics_publisher_cancelled"},
        )
        raise
```

- [ ] **Step 9: Run the test and confirm it passes**

```bash
cd services/tracking && python -m pytest tests/test_publish_metrics.py -v
```

Expected: PASS, 3 tests.

- [ ] **Step 10: Start it from a lifespan**

`services/tracking/src/main.py` has **no lifespan today** — its docstring says "there is nothing
to start or stop". That changes. Add above `create_app()`:

```python
from contextlib import asynccontextmanager

from src.features.tracking.commands.publish_metrics import run_metrics_publisher


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """Start the periodic metrics publisher for the lifetime of the process.

    Gated on `metrics_enabled`: create_app() is also called by tests/conftest.py for
    every REST test, and TestClient enters the lifespan — an ungated task would open a
    real database session and reach for CloudWatch on every test run.
    """
    settings = get_settings()
    task: asyncio.Task | None = None
    if settings.metrics_enabled:
        task = asyncio.create_task(
            run_metrics_publisher(interval=settings.metrics_interval_seconds)
        )
    try:
        yield
    finally:
        if task is not None:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
```

Add `metrics_enabled: bool = True` to `Settings` and set it to `False` in the test environment
(`tests/conftest.py`'s env setup, and `MINIMAL_ENV`/`MANAGED_KEYS` in `tests/test_settings.py`).
Then pass it at line ~94:

```python
    app = FastAPI(
        title="Tracking Service API",
        version="1.0.0",
        lifespan=_lifespan,
    )
```

Update `create_app`'s docstring — the "No lifespan: there is nothing to start or stop" line at
lines 76–78 is now wrong and would mislead the next reader.

- [ ] **Step 11: Run the full suite and lint**

```bash
cd services/tracking && python -m pytest && ruff check .
```

Expected: PASS. Integration-marked tests skip without MySQL, which is expected.

- [ ] **Step 12: Commit**

```bash
git add services/tracking
git commit -m "feat(tracking): publish orders-by-tracking-status gauge to CloudWatch"
```

---

### Task 6: events-pipeline — email sent/failed counters

**Files:**
- Create: `functions/events-pipeline/src/shared/metrics/cloudwatch-metrics.ts`
- Create: `functions/events-pipeline/tests/shared/metrics/cloudwatch-metrics.test.ts`
- Modify: `functions/events-pipeline/package.json` (add `@aws-sdk/client-cloudwatch`)
- Modify: `functions/events-pipeline/src/email/sender.ts` (success ~L91-98, failure ~L76-84)
- Modify: `functions/events-pipeline/src/shared/config/env.ts` (add `METRICS_ENABLED`)

**Interfaces:**
- Consumes: `env` from `#shared/config/env`.
- Produces:
  - `async function publishMetric(name, value, dimensions): Promise<void>` — never throws.
  - `sendEmail` gains a **required** `templateKey: string` field on `SendEmailParams`.
  - Metrics `emails_sent_total` and `emails_failed_total`, each published twice per event: once
    with the real `EmailType`, once with `EmailType=ALL`.

- [ ] **Step 1: Add the dependency**

```bash
cd functions/events-pipeline && nvm use && pnpm add @aws-sdk/client-cloudwatch@^3.1104.0
```

Match the newest sibling (`@aws-sdk/client-apigatewaymanagementapi` is `^3.1104.0`). esbuild
bundles it automatically — no `external` change needed in `scripts/build.mjs`.

- [ ] **Step 2: Write the failing test**

Create `functions/events-pipeline/tests/shared/metrics/cloudwatch-metrics.test.ts`, using the
class-stub mock pattern from `tests/websocket-publisher.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const cwSend = vi.fn();
vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: class {
    send = cwSend;
  },
  PutMetricDataCommand: class {
    constructor(public input: unknown) {}
  },
}));

const { publishMetric, resetMetricsClientForTests } = await import(
  "#shared/metrics/cloudwatch-metrics"
);

describe("publishMetric", () => {
  beforeEach(() => {
    cwSend.mockReset();
    cwSend.mockResolvedValue({});
    resetMetricsClientForTests();
  });

  it("sends one datum in the 3MRAI namespace with the given dimensions", async () => {
    await publishMetric("emails_sent_total", 1, {
      Service: "events-pipeline",
      EmailType: "user-created",
    });

    expect(cwSend).toHaveBeenCalledTimes(1);
    const input = (cwSend.mock.calls[0][0] as any).input;
    expect(input.Namespace).toBe("3MRAI");
    expect(input.MetricData[0].MetricName).toBe("emails_sent_total");
    expect(input.MetricData[0].Value).toBe(1);
    expect(input.MetricData[0].Dimensions).toEqual([
      { Name: "Service", Value: "events-pipeline" },
      { Name: "EmailType", Value: "user-created" },
    ]);
  });

  it("never throws when CloudWatch fails", async () => {
    cwSend.mockRejectedValue(new Error("CloudWatch is down"));

    await expect(
      publishMetric("emails_sent_total", 1, { Service: "events-pipeline", EmailType: "ALL" }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
cd functions/events-pipeline && nvm use && npx vitest run tests/shared/metrics/cloudwatch-metrics.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement the publisher**

Create `functions/events-pipeline/src/shared/metrics/cloudwatch-metrics.ts`, following
`src/email/sender.ts`'s lazy module-singleton pattern:

```ts
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { env } from "#shared/config/env";
import { appLogger } from "#shared/logging/app-logger";

/** The one namespace every 3MRAI metric is published under. */
export const METRICS_NAMESPACE = "3MRAI";

/** Every metric from this Lambda carries this Service dimension. */
export const SERVICE_DIMENSION = "events-pipeline";

let client: CloudWatchClient | undefined;

function getClient(): CloudWatchClient {
  if (!client) {
    client = new CloudWatchClient({
      region: env.AWS_REGION,
      ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
    });
  }
  return client;
}

/**
 * Publish one metric datum. NEVER throws.
 *
 * A metrics failure must not fail the record that produced it: the email was already
 * sent (or already failed for its own reason), and turning a metrics outage into a
 * TransientError would make SQS redeliver a message whose email work is done —
 * sending the customer a duplicate.
 */
export async function publishMetric(
  name: string,
  value: number,
  dimensions: Record<string, string>,
): Promise<void> {
  if (!env.METRICS_ENABLED) return;

  try {
    await getClient().send(
      new PutMetricDataCommand({
        Namespace: METRICS_NAMESPACE,
        MetricData: [
          {
            MetricName: name,
            Value: value,
            Unit: "Count",
            Dimensions: Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value })),
          },
        ],
      }),
    );
  } catch (err) {
    appLogger.warn(
      {
        app_event: "metric_publish_failed",
        reason: err instanceof Error ? err.message : String(err),
        metric_name: name,
      },
      "failed to publish metric",
    );
  }
}

/**
 * Publish a per-type series AND the ALL rollup.
 *
 * The rollup is a SEPARATE published series, not a query-time aggregate: Floci does
 * not aggregate across dimensions, so a dimensionless query for the total returns an
 * empty result with StatusCode "Complete".
 */
export async function publishEmailMetric(
  name: string,
  templateKey: string,
  extraDimensions: Record<string, string> = {},
): Promise<void> {
  await publishMetric(name, 1, {
    Service: SERVICE_DIMENSION,
    EmailType: templateKey,
    ...extraDimensions,
  });
  await publishMetric(name, 1, {
    Service: SERVICE_DIMENSION,
    EmailType: "ALL",
    ...extraDimensions,
  });
}

/** Test seam, mirroring resetSesClientForTests. */
export function resetMetricsClientForTests(): void {
  client = undefined;
}
```

Add to `src/shared/config/env.ts`'s Zod schema:

```ts
  // Defaulted so no Terraform block or test stub breaks by omitting it.
  METRICS_ENABLED: z.coerce.boolean().default(true),
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
cd functions/events-pipeline && nvm use && npx vitest run tests/shared/metrics/cloudwatch-metrics.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 6: Widen SendEmailParams and emit the counters**

`sendEmail` currently has no idea which template it is sending. Add `templateKey` to
`SendEmailParams` (L7-11):

```ts
export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  /** The catalog key that produced `html` — the EmailType metric dimension. */
  templateKey: string;
}
```

In the success branch, after the `email_send_succeeded` log (~L98):

```ts
  await publishEmailMetric("emails_sent_total", params.templateKey);
```

In the catch branch, after the `email_send_failed` log and **before**
`throw new TransientError(...)` (~L85):

```ts
  // Every SES failure is transient — this catch only ever sees SES errors, and
  // the throw below is unconditionally TransientError. A permanent failure comes
  // from the RENDERER (a missing template), never from here.
  await publishEmailMetric("emails_failed_total", params.templateKey, {
    FailureKind: "transient",
  });
```

Add the import: `import { publishEmailMetric } from "#shared/metrics/cloudwatch-metrics";`

Every caller of `sendEmail` must now pass `templateKey`. The five handlers in `src/handlers/`
already know their key — `user-created.ts` and `order-created.ts` use a literal, and
`tracking-status-changed.ts` selects one from `TEMPLATE_BY_STATUS` (L81-87). Update all five call
sites; `tsc` will point at each one.

- [ ] **Step 7: Emit the permanent-failure counter in the renderer**

In `src/email/renderer.ts`, before the `throw new PermanentError(...)` (~L20-23):

```ts
  if (!entry) {
    // A missing template is PERMANENT: the record will not be retried and the email
    // is lost. This counter is the only signal that a customer never got their mail,
    // which is why it is split from the transient SES failures.
    await publishEmailMetric("emails_failed_total", templateKey, {
      FailureKind: "permanent",
    });
    throw new PermanentError(`missing template: ${templateKey}`);
  }
```

`renderTemplate` is already `async`, so no signature change is needed.

- [ ] **Step 8: Add a test asserting the sender emits both series**

Append to `functions/events-pipeline/tests/email/sender.test.ts` — that file already points the
SES client at a dead endpoint (`http://127.0.0.1:1`) to force a `TransientError`, which makes it
the natural place to assert the failure counter. Mock the metrics module at the top of the file:

```ts
const publishEmailMetricMock = vi.fn(async () => {});
vi.mock("#shared/metrics/cloudwatch-metrics", () => ({
  publishEmailMetric: publishEmailMetricMock,
  publishMetric: vi.fn(async () => {}),
  resetMetricsClientForTests: vi.fn(),
}));
```

and add:

```ts
it("publishes a transient failure metric when SES fails", async () => {
  publishEmailMetricMock.mockClear();

  await expect(
    sendEmail({
      to: "ada@example.com",
      subject: "hi",
      html: "<p>hi</p>",
      templateKey: "user-created",
    }),
  ).rejects.toBeInstanceOf(TransientError);

  expect(publishEmailMetricMock).toHaveBeenCalledWith("emails_failed_total", "user-created", {
    FailureKind: "transient",
  });
});
```

- [ ] **Step 9: Typecheck, build and run the suite**

```bash
cd functions/events-pipeline && nvm use && pnpm run typecheck && pnpm run build && pnpm test
```

Expected: all PASS. `typecheck` is what surfaces any `sendEmail` call site still missing
`templateKey`.

- [ ] **Step 10: Commit**

```bash
git add functions/events-pipeline
git commit -m "feat(events-pipeline): publish email sent/failed metrics to CloudWatch"
```

---

### Task 7: HTTP error-rate metrics in Users, Orders and Tracking

**Files:**
- Modify: `services/users/src/features/users/http/routes.ts` (the `onResponse` hook, ~L112-128)
- Modify: `services/orders/src/Orders.Api/Program.cs` (after `UseSerilogRequestLogging`, ~L240)
- Create: `services/orders/src/Orders.Api/Middleware/HttpErrorMetricsMiddleware.cs`
- Modify: `services/tracking/src/shared/http/log_context_middleware.py` (wrap `send`)
- Create: `services/tracking/tests/test_http_error_metrics.py`

**Interfaces:**
- Consumes: each service's metrics publisher (Tasks 2, 4, 5).
- Produces: metric `http_errors_total` with `Service=<name>` + `StatusClass=4xx|5xx` in all three.

- [ ] **Step 1: Users — emit from the existing onResponse hook**

`routes.ts` L112-128 already logs `reply.statusCode` for every response. Add, inside that hook:

```ts
  const status = reply.statusCode;
  if (status >= 400) {
    const statusClass = status >= 500 ? "5xx" : "4xx";
    // Not awaited: onResponse must not delay the connection teardown, and
    // publish() never rejects.
    void req.diScope.cradle.metricsPublisher.publish("http_errors_total", 1, {
      Service: "users",
      StatusClass: statusClass,
    });
  }
```

> Only 4xx and 5xx are counted. A metric per 2xx would be a request-rate metric, which the logs
> already provide and which multiplies the published series for no added signal.

- [ ] **Step 2: Users — test it**

Add to `services/users/tests/features/users/http/routes.test.ts`:

```ts
it("publishes http_errors_total on a 401", async () => {
  const publish = vi.fn(async () => {});
  const app = buildAppWithMetrics({ publish });   // existing helper style in this file
  const res = await app.inject({ method: "GET", url: "/v1/users/me" });   // no x-user-id
  expect(res.statusCode).toBe(401);
  expect(publish).toHaveBeenCalledWith("http_errors_total", 1, {
    Service: "users",
    StatusClass: "4xx",
  });
  await app.close();
});
```

If no `buildAppWithMetrics` helper exists in that file, build the app with a container whose
`metricsPublisher` is registered `asValue({ publish })` — `buildApp` accepts a container argument
(`routes.ts:90-93`).

- [ ] **Step 3: Orders — add the middleware**

Create `services/orders/src/Orders.Api/Middleware/HttpErrorMetricsMiddleware.cs`:

```csharp
using Orders.Application.Abstractions;

namespace Orders.Api.Middleware;

/// <summary>
/// Publishes http_errors_total for any response with status >= 400.
///
/// Placed immediately after UseSerilogRequestLogging so it observes the FINAL status
/// of the completed response — including statuses set by short-circuiting middleware
/// and by per-endpoint results, which an endpoint filter would miss.
/// </summary>
public class HttpErrorMetricsMiddleware
{
    private readonly RequestDelegate _next;
    private readonly IMetricsPublisher _metrics;

    public HttpErrorMetricsMiddleware(RequestDelegate next, IMetricsPublisher metrics)
    {
        _next = next;
        _metrics = metrics;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        await _next(context);

        var status = context.Response.StatusCode;
        if (status >= 400)
        {
            await _metrics.PublishAsync(
                "http_errors_total",
                1,
                new Dictionary<string, string>
                {
                    ["Service"] = "orders",
                    ["StatusClass"] = status >= 500 ? "5xx" : "4xx",
                },
                context.RequestAborted);
        }
    }
}
```

Register it in `Program.cs` right after `app.UseSerilogRequestLogging(...)` (~L240):

```csharp
app.UseMiddleware<HttpErrorMetricsMiddleware>();
```

- [ ] **Step 4: Orders — test it**

Add `services/orders/tests/Orders.Tests/Api/HttpErrorMetricsTests.cs` using the existing
`OrdersApiFactory` collection fixture, with a recording `IMetricsPublisher` swapped in via
`ConfigureTestServices` (same idiom as `NoopMetricsPublisher` in Task 4 Step 8), asserting that a
request with no `x-user-id` produces a 401 and one `http_errors_total` / `4xx` publication.

- [ ] **Step 5: Tracking — wrap `send` in the existing ASGI middleware**

`LogContextMiddleware` (`src/shared/http/log_context_middleware.py:40-58`) is pure ASGI and passes
`send` straight through, so it never sees the status. Wrap it:

```python
    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        status_holder: dict[str, int] = {}

        async def send_wrapper(message):
            # http.response.start is the ONLY message carrying the status.
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
            await send(message)

        # ... existing context setup ...
        await self.app(scope, receive, send_wrapper)

        status = status_holder.get("status")
        if status is not None and status >= 400:
            publisher = self._metrics or shared_metrics_publisher()
            await asyncio.to_thread(
                publisher.publish,
                "http_errors_total",
                1,
                {"Service": "tracking", "StatusClass": "5xx" if status >= 500 else "4xx"},
            )
```

> Keep this middleware **pure ASGI**. Do not convert it to `BaseHTTPMiddleware`: Starlette runs
> that in a sibling anyio task, so contextvars set by handlers are invisible to it — the
> documented reason this class is written the way it is.

Accept an optional `metrics` parameter on `__init__` so tests inject a recorder instead of
reaching for the lru_cached boto3 client.

- [ ] **Step 6: Tracking — test it**

Create `services/tracking/tests/test_http_error_metrics.py` asserting that a request to a
nonexistent route (404) publishes `http_errors_total` with `StatusClass=4xx`, and that a 200
publishes nothing.

- [ ] **Step 7: Run all three suites**

```bash
cd services/users && nvm use && npm test
cd ../orders && dotnet test
cd ../tracking && python -m pytest && ruff check .
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add services/users services/orders services/tracking
git commit -m "feat(users,orders,tracking): publish http_errors_total by status class"
```

---

### Task 8: IAM permission and env-file wiring

**Files:**
- Modify: `infra/modules/lambda/main.tf` (the inline policy, ~L31-95)
- Modify: `infra/environments/local/scripts/generate_env_files.py` (per-service blocks)
- Modify: `.env.example` (document the new vars)

**Interfaces:**
- Consumes: nothing.
- Produces: `cloudwatch:PutMetricData` permission for the Lambda; `METRICS_*` vars in every
  generated env file.

- [ ] **Step 1: Grant PutMetricData to the Lambda**

In `infra/modules/lambda/main.tf`, add a statement to the inline policy beside the existing
`ses:SendEmail` one (~L55):

```hcl
      {
        Effect = "Allow"
        # PutMetricData supports no resource-level permissions — "*" is the only
        # valid Resource for this action, not a shortcut.
        Action   = ["cloudwatch:PutMetricData"]
        Resource = "*"
      },
```

The three container services reach Floci with static local credentials and need no IAM change
locally; in real AWS their task roles would need the same statement.

- [ ] **Step 2: Add the env vars to the generator**

In `infra/environments/local/scripts/generate_env_files.py`, add to each service's dict beside its
existing `OTEL_*` entries:

- `.env.local.users` → `"METRICS_INTERVAL_MS": "15000"`
- `.env.local.orders` → `"METRICS_INTERVAL_MS": "15000"`
- `.env.local.tracking` → `"METRICS_INTERVAL_SECONDS": "15"`, `"METRICS_ENABLED": "true"`
- `.env.local.events-pipeline` → `"METRICS_ENABLED": "true"`

Also add `METRICS_ENABLED = "true"` to the Lambda's `environment_variables` block in
`infra/environments/local/main.tf` (~L442-484).

- [ ] **Step 3: Document them in the contract**

Add the same keys to the matching sections of `.env.example`, with a one-line comment each.
`.env.example` is documentation, not config — nothing loads it — but it is the committed contract
and a var absent from it is invisible to the next reader.

- [ ] **Step 4: Regenerate and verify**

```bash
make env-file
grep -n "METRICS" .env.local.users .env.local.orders .env.local.tracking .env.local.events-pipeline
```

Expected: each var appears in its file, inside the AUTO-GENERATED box. Confirm your CUSTOM boxes
survived.

- [ ] **Step 5: Commit**

```bash
git add infra .env.example
git commit -m "feat(infra): grant PutMetricData and wire metrics env vars"
```

---

### Task 9: Dashboards and end-to-end verification

**Files:**
- Create: `observability/dashboards/business-metrics.dashboard.json`
- Modify: `observability/otel-collector-config.yaml` (per-type email queries, if adopted)

**Interfaces:**
- Consumes: every metric from Tasks 2–7.
- Produces: an importable OpenObserve dashboard.

- [ ] **Step 1: Bring the whole stack up**

```bash
make bootstrap && make observability-up
```

- [ ] **Step 2: Generate real traffic**

Register a user (both with and without a password), create an order, drive a tracking to
`DELIVERED` via TestMode, and trigger a password reset. Use the E2E suite for this if it is
quicker: `pnpm --filter @3mrai/e2e test`.

- [ ] **Step 3: Verify every metric arrives**

Wait at least **40 seconds** (≥2 collection intervals at 15s), then query each stream:

```bash
AUTH="Basic $(printf 'admin@3mrai.local:Complexpass#123' | base64)"
for m in users_registered_total users_total password_resets_total orders_total \
         orders_by_tracking_status_total emails_sent_total http_errors_total; do
  echo "--- $m ---"
  curl -s -X POST -H "Authorization: $AUTH" -H "Content-Type: application/json" \
    "http://localhost:5080/api/default/_search?type=metrics" \
    -d "{\"query\":{\"sql\":\"SELECT * FROM \\\"amazonaws_com_3mrai_${m}\\\" LIMIT 3\",\"start_time\":0,\"end_time\":9999999999999999,\"from\":0,\"size\":3}}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print('hits:',len(d.get('hits',[])));[print(' ',h.get('dimensions_service'),h.get('value')) for h in d.get('hits',[])[:3]]"
done
```

Expected: **every** metric reports `hits: > 0`. A `hits: 0` with an HTTP 200 is a FAILURE — it is
the silent-empty mode from spike finding #1, and it means either the dimension set in the
collector's `queries` block does not match what the service published, or the service is not
publishing at all. Check the service's logs for `metric_publish_failed` before touching the
collector.

- [ ] **Step 4: Verify the Orders↔Tracking health indicator**

```
orders_total  vs  (DELIVERED + IN_PROGRESS)
```

Expected: **equal**, because Orders calls `init-tracking` during order creation. A difference
means some order's `init-tracking` failed — check the Orders logs for `init_tracking_failed`.
Record the observed values in the dashboard's description so a future reader knows what normal
looks like.

- [ ] **Step 5: Build the dashboard**

Create `observability/dashboards/business-metrics.dashboard.json` following the existing
dashboards' structure. Panels:

1. **Users registered** (time series, `users_registered_total`)
2. **Users by auth type** (stat, two series from `users_total` on `dimensions_haspassword`)
3. **Password resets** (time series)
4. **Orders: total vs tracked** (time series, `orders_total` and both
   `orders_by_tracking_status_total` series — the gap is the health indicator)
5. **Orders finished vs in progress** (pie or stacked, `dimensions_status`)
6. **Emails sent** (time series, `dimensions_emailtype = 'ALL'`)
7. **Email failures by kind** (time series split on `dimensions_failurekind` — permanent is the
   alarming one)
8. **HTTP errors by service and class** (time series, `dimensions_service` × `dimensions_statusclass`)

> Query the **prefixed, lowercased** dimension names (`dimensions_service`, `dimensions_status`),
> not the CloudWatch names. This is finding #3 in the spec.

- [ ] **Step 6: Import and verify the dashboard renders**

```bash
make observability-dashboards
```

Open <http://localhost:5080>, confirm every panel shows data. **A panel rendering an empty chart
without an error is the failure mode to look for** — check its query's dimension names first.

- [ ] **Step 7: Decide the per-type email series**

With real data in hand, decide whether to add the nine per-`EmailType` queries explicitly to the
collector config or to switch that one metric to `discovery` (which would pick up new template
keys automatically). Note the trade-off in the dashboard description either way — an undocumented
`ALL`-only view reads as "all emails are one type".

- [ ] **Step 8: Commit**

```bash
git add observability
git commit -m "feat(infra): add business metrics dashboard"
```

---

## Self-Review

**Spec coverage** — every section of the design maps to a task:

| Spec section | Task |
|---|---|
| Pipeline (CloudWatch → collector → OpenObserve) | 1 |
| Polling intervals (15s local / 60s AWS) | 1, 3, 4, 5, 8 |
| Users metrics (3) | 2, 3 |
| Orders `orders_total` | 4 |
| Tracking `orders_by_tracking_status_total` | 5 |
| events-pipeline email metrics | 6 |
| `http_errors_total` (3 services) | 7 |
| Gauges by periodic task, counters at the event | 2–6 |
| Collector configuration | 1 |
| Testing (3 layers, adapted) | per-task steps + 9 |
| Non-goals | not implemented, by design |

**Known gaps, stated rather than hidden:**

- **Per-`EmailType` series are not in the collector's `queries`** — only `EmailType=ALL` is.
  Task 9 Step 7 makes that an explicit decision rather than an oversight.
- **Task 7's Orders and Tracking tests are described, not written out.** Their shape follows
  Task 4's and Task 5's test code directly; the implementer has a working model in the same plan.
  Users' is written out because its DI-container seam is the least obvious of the three.
- **No alarms.** Out of scope per the spec.

## Related

- [[2026-08-12-custom-business-metrics-cloudwatch-design]] — the design this implements.
- [[logging-context]] — the `OTEL_METRICS_EXPORTER=none` rule left in place, and the
  log-and-swallow stance every publisher here follows.
- [[env-files]] — where `METRICS_*` belongs and why it is generated, never hand-edited.
- [[testing]] — the three-layer rule, adapted for non-HTTP surfaces.
- [[ADR-0017-floci-local]] — the emulator whose behaviour constrains the dimension rules.
