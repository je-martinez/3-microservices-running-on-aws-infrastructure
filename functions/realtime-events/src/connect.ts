import type { APIGatewayProxyResult } from "aws-lambda";
import { saveConnection } from "#shared/connections-repository";
import { logger } from "#shared/logging/logger";

interface ConnectEvent {
  requestContext: {
    connectionId: string;
    authorizer?: Record<string, string>;
  };
}

export async function handler(event: ConnectEvent): Promise<APIGatewayProxyResult> {
  const connectionId = event.requestContext.connectionId;
  // From the authorizer's returned context — verified on Floci to propagate
  // intact. NEVER read the token from the query string here: this handler does
  // not validate anything, so trusting a request value would let an unverified
  // caller choose whose events they receive.
  const cognitoSub = event.requestContext.authorizer?.cognito_sub;

  if (!cognitoSub) {
    // Should be unreachable: the route is behind the authorizer, so a missing
    // context means a wiring fault. Fail loudly rather than persisting a row
    // with no owner, which would be invisible until it silently received
    // nothing.
    logger.error({
      app_event: "ws_connect_failed",
      reason: "missing_authorizer_context",
      connection_id: connectionId,
    });
    return { statusCode: 500, body: "missing authorizer context" };
  }

  await saveConnection(connectionId, cognitoSub);
  logger.info({
    app_event: "ws_connected",
    connection_id: connectionId,
    cognito_sub: cognitoSub,
  });
  return { statusCode: 200, body: "connected" };
}
