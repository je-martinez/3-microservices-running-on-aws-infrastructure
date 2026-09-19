import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { SpanKind, trace } from "@opentelemetry/api";
import { envSchema, type Env } from "#config/env.schema";
import { appLogger } from "#shared/logging/app-logger";
import {
  createConnectionsReader,
  type ConnectionsConfig,
} from "#shared/realtime/connections-reader";
import { withClientSpan } from "#shared/observability/client-span";

/**
 * The frame the web app receives. `unread_count` rides along so the badge updates
 * without a second request.
 */
export interface NotificationCreatedMessage {
  type: "NOTIFICATION_CREATED";
  notification: {
    id: string;
    type: string;
    title: string;
    body: string;
    metadata: unknown;
    read_at: string | null;
  };
  unread_count: number;
}

type PublishConfig = ConnectionsConfig & Pick<Env, "WS_MANAGEMENT_ENDPOINT">;

export function createPublishToUser(config: PublishConfig) {
  let apiClient: ApiGatewayManagementApiClient | null = null;
  const { queryByCognitoSub, deleteConnection } = createConnectionsReader(config);

  function client(): ApiGatewayManagementApiClient {
    if (apiClient === null) {
      // WORKAROUND(local): Floci's @connections endpoint carries an undocumented
      // /execute-api/{apiId}/{stage} prefix, unlike real AWS. Generated into the env
      // file, never derived. A wrong endpoint answers HTTP 400 with an S3 XML body,
      // which looks nothing like an endpoint problem.
      // See [[floci-websocket-apigw-dynamodb-support]]
      apiClient = new ApiGatewayManagementApiClient({
        region: config.AWS_REGION,
        endpoint: config.WS_MANAGEMENT_ENDPOINT,
      });
    }
    return apiClient;
  }

  function isGone(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    return e.name === "GoneException" || e.$metadata?.httpStatusCode === 410;
  }

  async function fanOut(cognitoSub: string, message: unknown): Promise<void> {
    const span = trace.getActiveSpan();
    try {
      const connectionIds = await queryByCognitoSub(cognitoSub);
      // Recorded even when zero, and BEFORE the early return: "the user had nothing
      // open" and "the fan-out never got that far" are different stories, and a
      // missing attribute cannot tell them apart.
      span?.setAttribute("messaging.batch.message_count", connectionIds.length);
      if (connectionIds.length === 0) return;

      const data = Buffer.from(JSON.stringify(message));

      await Promise.all(
        connectionIds.map(async (connectionId) => {
          try {
            await client().send(
              new PostToConnectionCommand({ ConnectionId: connectionId, Data: data }),
            );
          } catch (error) {
            if (isGone(error)) {
              // The reactive cleanup the design leans on — the TTL is only a
              // backstop. A dead connection is expected, not a failure.
              await deleteConnection(connectionId).catch(() => undefined);
              return;
            }
            appLogger.error({
              app_event: "notification_push_failed",
              connection_id: connectionId,
              reason: error instanceof Error ? error.message : "unknown",
            });
          }
        }),
      );
    } catch (error) {
      appLogger.error({
        app_event: "notification_push_failed",
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  /**
   * Fan a message out to every socket the user has open. NEVER throws.
   *
   * CONTRACT: The push must never fail the persistence. The row is already
   * committed and appears when the panel is opened, so raising here would lose a
   * stored notification over a socket problem — and on SQS redelivery would store
   * it twice. Realtime is an enhancement, never the source of truth.
   * See [[2026-09-10-in-app-notifications-design]]
   */
  return async function publishToUser(cognitoSub: string, message: unknown): Promise<void> {
    // Manual PRODUCER span, as the pipeline's publisher has: `describeError` is
    // required because this function never throws, so the outcome rides on the
    // attributes rather than the span status.
    return withClientSpan(
      "ws publish",
      SpanKind.PRODUCER,
      { "messaging.system": "apigatewaymanagementapi", "messaging.operation": "publish" },
      () => fanOut(cognitoSub, message),
      (error) => (error instanceof Error ? error.message : "unknown"),
    );
  };
}

// CONTRACT: Resolve LAZILY. Parsing the environment at module-eval time kills
// the process on import, before Nest can report which variable is missing, and
// forces every test that merely imports this module to supply a full
// environment.
// CONTRACT: Temporary bridge. It disappears once a Nest module provides this;
// nothing new may import it.
let publisher: ReturnType<typeof createPublishToUser> | undefined;

export const publishToUser: ReturnType<typeof createPublishToUser> = (...args) => {
  publisher ??= createPublishToUser(envSchema.parse(process.env));
  return publisher(...args);
};
