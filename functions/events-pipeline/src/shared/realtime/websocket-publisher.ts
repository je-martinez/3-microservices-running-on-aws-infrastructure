import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import {
  queryByCognitoSub,
  deleteConnection,
} from "#shared/realtime/connections-reader";
// `appLogger`, NOT a `logger` export from #shared/logging/logger — that module
// exports `buildLoggerOptions`/`SEVERITY_NUMBER` only. `app-logger` is what
// every other module in this package imports (see handler.ts,
// pipeline/process-record.ts).
import { appLogger } from "#shared/logging/app-logger";

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
 *
 * The WebSocket push must never change the outcome of event processing: the
 * email is the durable notification and this is an opportunistic enhancement on
 * top of it. Failing the event so SQS retries it would send a SECOND email for
 * a transition the user was already notified about — trading a realtime failure
 * for a duplicate email, which is the trade the pipeline's publish-failure
 * policy already rejects everywhere else.
 */
export async function publishToUser(
  cognitoSub: string,
  message: unknown,
): Promise<void> {
  try {
    const connectionIds = await queryByCognitoSub(cognitoSub);
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
