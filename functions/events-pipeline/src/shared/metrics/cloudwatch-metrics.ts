import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { env } from "#shared/config/env";
import { appLogger } from "#shared/logging/app-logger";

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
    // Swallowed on purpose — see the function docstring. Only the message
    // reaches the log: metric names and dimensions here are low-cardinality
    // labels from our own code, never PII.
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
