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
 * A metrics failure must not fail the record that produced it: the email was
 * already sent (or already failed for its own reason), and turning a metrics
 * outage into a TransientError would make SQS redeliver a message whose email
 * work is done — sending the customer a duplicate.
 */
export async function publishMetric(
  name: string,
  value: number,
  dimensions: Record<string, string>,
): Promise<void> {
  // Opened BEFORE the enabled check returns, so a disabled exporter produces no
  // span at all rather than a zero-duration one implying a call was made.
  if (!env.METRICS_ENABLED) return;

  // Manual CLIENT span, same bundling reason as the DocumentDB and SES ones: the
  // AWS SDK is inlined by esbuild, so nothing auto-instruments this.
  //
  // It was the LAST hole in `process_record`. With the DocumentDB transitions and
  // the template render instrumented, a ~44ms gap still sat between `ses
  // SendEmail` and `ws publish` — this call, twice: publishEmailMetric emits a
  // per-template series AND an ALL rollup, so one "publish a metric" is two round
  // trips. Two spans is the honest rendering of that, and it is why the gap was
  // wider than a single PutMetricData would explain.
  //
  // NOT withClientSpan: that helper rethrows, and this function's entire contract
  // is that it never does. A metric failure must not fail the record, so the span
  // records the failure and the function still returns normally — the span status
  // reports what happened to the CALL, not to the caller.
  // The metric name is IN the span name, not only in the attribute below. A
  // waterfall renders names: `publishEmailMetric` emits two data points per
  // email (a per-template series and an ALL rollup), so a record showed two
  // identical `cloudwatch PutMetricData` bars and telling them apart — or
  // knowing what either one published — took a click into the attributes. Same
  // reasoning as `documentdb updateOne <STATUS>`.
  await pipelineTracer.startActiveSpan(
    `cloudwatch PutMetricData ${name}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "rpc.system": "aws-api",
        "rpc.service": "CloudWatch",
        "rpc.method": "PutMetricData",
        "metric.name": name,
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
        // Swallowed on purpose — see the function docstring. Only the message
        // reaches the log: metric names and dimensions here are low-cardinality
        // labels from our own code, never PII. The same string is safe on the
        // span for the same reason.
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
 *
 * The rollup is a SEPARATE published series, not a query-time aggregate: Floci
 * does not aggregate across dimensions, so a dimensionless query for the total
 * returns an empty result with StatusCode "Complete" — a silent zero, not an
 * error.
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
