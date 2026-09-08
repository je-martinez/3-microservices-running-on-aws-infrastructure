import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { env } from "#shared/config/env";
import { appLogger } from "#shared/logging/app-logger";
import { pipelineTracer } from "#shared/observability/tracing";

/** The one namespace every 3MRAI metric is published under. */
export const METRICS_NAMESPACE = "3MRAI";

/** Every metric from this Lambda carries this Service dimension. */
export const SERVICE_DIMENSION = "events-pipeline";

// Module-scope singleton, created LAZILY — same shape and same reasons as
// #email/sender's SES client: reused across warm invocations, but not
// constructed at import time, so merely importing this module does not require
// the full env.
let client: CloudWatchClient | undefined;

function getClient(): CloudWatchClient {
  if (!client) {
    client = new CloudWatchClient({
      region: env.AWS_REGION,
      // Set only when present: locally it points at Floci (:4566); in AWS the
      // variable is absent and the SDK resolves the real regional endpoint.
      ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
    });
  }
  return client;
}

/**
 * Publish one metric datum. NEVER throws.
 *
 * CONTRACT: A metrics outage must not become a TransientError — SQS would
 * redeliver a message whose email is already sent, duplicating it.
 */
export async function publishMetric(
  name: string,
  value: number,
  dimensions: Record<string, string>,
  // Distinguishes sibling publishes of the SAME metric in the waterfall. Only
  // publishEmailMetric passes it today (per-template vs the ALL rollup); a
  // single-series caller leaves the span named after the metric alone, as before.
  spanLabel?: string,
): Promise<void> {
  // Opened BEFORE the enabled check returns, so a disabled exporter produces no
  // span at all rather than a zero-duration one implying a call was made.
  if (!env.METRICS_ENABLED) return;

  // CONTRACT: Do NOT switch this to `withClientSpan`. That helper rethrows, and
  // this function's contract is that it never does — a metric failure would then
  // fail a record whose email already went out. The span reports what happened
  // to the CALL, not to the caller.

  // WHY: The metric name and `spanLabel` go IN the span name — a waterfall
  // renders names, and publishEmailMetric emits two data points per email (a
  // per-template series and the ALL rollup) that otherwise draw as two identical
  // bars. Manual span: esbuild inlines the AWS SDK, so nothing auto-instruments.
  await pipelineTracer.startActiveSpan(
    spanLabel === undefined
      ? `cloudwatch PutMetricData ${name}`
      : `cloudwatch PutMetricData ${name} (${spanLabel})`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "rpc.system": "aws-api",
        "rpc.service": "CloudWatch",
        "rpc.method": "PutMetricData",
        "metric.name": name,
        // WHY: The queryable form of what the span name carries — a name reads
        // a waterfall, an attribute filters a dashboard.
        ...(dimensions.EmailType === undefined
          ? {}
          : { "metric.email_type": dimensions.EmailType }),
      },
    },
    async (span) => {
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
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        // Swallowed on purpose — see the docstring. Safe to log: metric names
        // and dimensions are low-cardinality labels from our own code, never PII.
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        appLogger.warn(
          {
            app_event: "metric_publish_failed",
            reason: err instanceof Error ? err.message : String(err),
            metric_name: name,
          },
          "failed to publish metric",
        );
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Publish a per-type series AND the ALL rollup.
 * WORKAROUND(local): The rollup is published as its own series — Floci does not
 * aggregate across dimensions and answers a dimensionless total with an empty
 * result and StatusCode "Complete" (a silent zero, not an error).
 */
export async function publishEmailMetric(
  name: string,
  templateKey: string,
  extraDimensions: Record<string, string> = {},
): Promise<void> {
  await publishMetric(
    name,
    1,
    { Service: SERVICE_DIMENSION, EmailType: templateKey, ...extraDimensions },
    templateKey,
  );
  await publishMetric(
    name,
    1,
    { Service: SERVICE_DIMENSION, EmailType: "ALL", ...extraDimensions },
    "ALL",
  );
}

/** Test seam, mirroring resetSesClientForTests. */
export function resetMetricsClientForTests(): void {
  client = undefined;
}
