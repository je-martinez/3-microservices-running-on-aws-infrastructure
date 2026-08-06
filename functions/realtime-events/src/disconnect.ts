import type { APIGatewayProxyResult } from "aws-lambda";
import { deleteConnection } from "#shared/connections-repository";
import { logger } from "#shared/logging/logger";

interface DisconnectEvent {
  requestContext: { connectionId: string };
}

export async function handler(
  event: DisconnectEvent,
): Promise<APIGatewayProxyResult> {
  const connectionId = event.requestContext.connectionId;
  try {
    await deleteConnection(connectionId);
    logger.info({ app_event: "ws_disconnected", connection_id: connectionId });
  } catch (error) {
    // Swallowed: the socket is already gone, so there is nothing to fail back
    // to. A row left behind is harmless — the events-pipeline prunes it on the
    // next 410 Gone, and the TTL bounds it regardless.
    logger.error({
      app_event: "ws_disconnect_cleanup_failed",
      connection_id: connectionId,
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
  return { statusCode: 200, body: "disconnected" };
}
