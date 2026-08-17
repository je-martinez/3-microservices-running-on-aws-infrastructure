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
              // CloudWatch's list-of-{Name,Value} shape. The exact dimension SET
              // is load-bearing: a query naming a different set comes back EMPTY
              // with StatusCode "Complete" rather than as an error.
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
