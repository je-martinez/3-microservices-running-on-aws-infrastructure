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
    // A span of OUR OWN, naming the metric, rather than relying on the AWS SDK
    // auto-instrumentation. The auto span is called `CloudWatch.PutMetricData`
    // and carries no metric name at all, so this service produced 3,698
    // identical, unreadable bars — "something published something". A waterfall
    // renders names, so the name is where the answer has to be.
    //
    // It wraps the SDK call, so the auto-instrumented span remains as its child.
    // That extra level is accepted deliberately: suppressing it means
    // configuring the SDK's instrumentation in code, which has silently broken
    // telemetry three times in this repo (see the OTel env-var convention).
    // A readable parent is worth one nested bar.
    //
    // NOT ended in a catch: `publish` swallows every failure by contract, so the
    // span records the outcome of the CALL while the method still returns
    // normally.
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
