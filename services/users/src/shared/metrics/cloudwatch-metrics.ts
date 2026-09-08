import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { appLogger } from "../logging/app-logger.ts";

/** The one namespace every 3MRAI metric is published under. */
export const METRICS_NAMESPACE = "3MRAI";

// Own tracer, named for its area — same convention as publish-tracing's
// `users-messaging`.
const tracer = trace.getTracer("users-metrics");

/**
 * Publishes custom metrics to CloudWatch.
 *
 * Every failure is logged and swallowed: an unreachable metrics backend must never
 * fail the registration, login or password reset that triggered the metric.
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
    // CONTRACT: Name the span after the metric. The AWS SDK's auto span is called
    // `CloudWatch.PutMetricData` with no metric name, producing thousands of identical
    // unreadable bars. Do NOT suppress that child span — that means configuring the
    // SDK's instrumentation in code, which has silently broken telemetry three times
    // here. `publish` swallows every failure, so the span records the call's outcome
    // while the method returns normally. See [[logging-context]]
    await tracer.startActiveSpan(
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
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (err) {
          // Swallowed on purpose — see the class docstring.
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
}
