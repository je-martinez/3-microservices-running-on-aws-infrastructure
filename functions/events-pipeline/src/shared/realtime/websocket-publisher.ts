import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { SpanKind, trace } from "@opentelemetry/api";
import {
  queryByCognitoSub,
  deleteConnection,
} from "#shared/realtime/connections-reader";
// `appLogger`, NOT a `logger` export from #shared/logging/logger — that module
// exports `buildLoggerOptions`/`SEVERITY_NUMBER` only. `app-logger` is what
// every other module in this package imports (see handler.ts,
// pipeline/process-record.ts).
import { appLogger } from "#shared/logging/app-logger";
import { withClientSpan } from "#shared/observability/client-span";

let apiClient: ApiGatewayManagementApiClient | null = null;

function client(): ApiGatewayManagementApiClient {
  if (apiClient === null) {
    // Locally this is Floci's UNDOCUMENTED /execute-api/{apiId}/{stage} shape,
    // not the real-AWS https://{apiId}.execute-api.{region}.amazonaws.com/{stage}.
    // Generated into the env file, never hardcoded. A wrong endpoint answers
    // HTTP 400 with an S3 XML body (unrouted :4566 paths hit Floci's S3
    // handler), which looks nothing like an endpoint problem.
    apiClient = new ApiGatewayManagementApiClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      endpoint: process.env.WS_MANAGEMENT_ENDPOINT,
    });
  }
  return apiClient;
}

function isGone(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "GoneException" || e.$metadata?.httpStatusCode === 410;
}

/**
 * Fan a message out to every socket the user has open. NEVER throws.
 * CONTRACT: The push must never change the outcome of event processing. The
 * email is the durable notification; failing the event so SQS retries it sends
 * a SECOND email for a transition the user was already notified about.
 */
export async function publishToUser(
  cognitoSub: string,
  message: unknown,
): Promise<void> {
  // Manual PRODUCER span — the SDK is inlined by esbuild, so nothing
  // auto-instruments it. `describeError` is defensive: this function never
  // throws, so the outcome rides on the attributes below rather than the span
  // status. A fan-out where every push failed still ends OK, because the RECORD
  // succeeded; `ws_push_failed` on the log line carries that detail.
  return withClientSpan(
    "ws publish",
    SpanKind.PRODUCER,
    { "messaging.system": "apigatewaymanagementapi", "messaging.operation": "publish" },
    () => fanOut(cognitoSub, message),
    (error) => (error instanceof Error ? error.message : "unknown"),
  );
}

async function fanOut(cognitoSub: string, message: unknown): Promise<void> {
  const span = trace.getActiveSpan();
  try {
    const connectionIds = await queryByCognitoSub(cognitoSub);
    // Recorded even when zero, and BEFORE the early return: "the user had
    // nothing open" and "the fan-out never got that far" are different stories,
    // and a missing attribute cannot tell them apart.
    span?.setAttribute("messaging.batch.message_count", connectionIds.length);
    if (connectionIds.length === 0) {
      // Normal, not an error: the user simply has nothing open right now.
      return;
    }

    const data = Buffer.from(JSON.stringify(message));

    await Promise.all(
      connectionIds.map(async (connectionId) => {
        try {
          await client().send(
            new PostToConnectionCommand({
              ConnectionId: connectionId,
              Data: data,
            }),
          );
        } catch (error) {
          if (isGone(error)) {
            // The reactive cleanup the whole design leans on — the TTL is only
            // a backstop. A dead connection is expected, not a failure.
            await deleteConnection(connectionId).catch(() => undefined);
            return;
          }
          appLogger.error({
            app_event: "ws_push_failed",
            connection_id: connectionId,
            reason: error instanceof Error ? error.message : "unknown",
          });
        }
      }),
    );
  } catch (error) {
    appLogger.error({
      app_event: "ws_fanout_failed",
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}
