import type { APIGatewayProxyResult } from "aws-lambda";
import { logger } from "#shared/logging/logger";

interface DefaultEvent {
  requestContext: { connectionId: string };
}

/**
 * $default — the channel is server-to-client only.
 *
 * Declared rather than omitted deliberately: with no $default route an inbound
 * message vanishes silently, so a client that wrongly believes it can subscribe
 * gets no signal at all. This route mutates no connection state; it only tells
 * the caller its message went nowhere.
 */
export async function handler(
  event: DefaultEvent,
): Promise<APIGatewayProxyResult> {
  logger.warn({
    app_event: "ws_unexpected_inbound_message",
    connection_id: event.requestContext.connectionId,
  });
  return {
    statusCode: 400,
    body: JSON.stringify({
      error: "this channel is server-to-client only; inbound messages are ignored",
    }),
  };
}
