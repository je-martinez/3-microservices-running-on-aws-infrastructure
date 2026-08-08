import type {
  APIGatewayRequestAuthorizerEvent,
  APIGatewayAuthorizerResult,
} from "aws-lambda";
import { verifyCognitoToken } from "#shared/jwt";
import { logger } from "#shared/logging/logger";

// The token travels in the QUERY STRING, not a header. This is forced, not
// preferred: a browser's `new WebSocket(url)` cannot set custom headers, and a
// POC on 2026-08-05 confirmed the only headers reaching this authorizer are
// the handshake's own (Sec-WebSocket-Key, Connection, Sec-WebSocket-Version,
// Host, Upgrade) — no Authorization header arrives at all.
function policy(
  effect: "Allow" | "Deny",
  methodArn: string,
  context?: Record<string, string>,
): APIGatewayAuthorizerResult {
  return {
    principalId: context?.cognito_sub ?? "anonymous",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        { Action: "execute-api:Invoke", Effect: effect, Resource: methodArn },
      ],
    },
    ...(context ? { context } : {}),
  };
}

export async function handler(
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> {
  const token = event.queryStringParameters?.token;

  if (!token) {
    // Never log the token itself, present or not — see the logging convention.
    logger.warn({ app_event: "ws_connect_denied", reason: "missing_token" });
    return policy("Deny", event.methodArn);
  }

  try {
    const { sub } = await verifyCognitoToken(token);
    logger.info({ app_event: "ws_connect_authorized", cognito_sub: sub });
    return policy("Allow", event.methodArn, { cognito_sub: sub });
  } catch {
    // Deliberately does not distinguish expired / malformed / wrong-audience:
    // the client learns only that the handshake failed.
    logger.warn({ app_event: "ws_connect_denied", reason: "invalid_token" });
    return policy("Deny", event.methodArn);
  }
}
