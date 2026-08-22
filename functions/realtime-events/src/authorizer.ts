// Tracing FIRST — see the note at the top of connect.ts.
import { flushTraces, wsTracer } from "#shared/observability/tracing";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
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
  return wsTracer.startActiveSpan("ws_authorize", { kind: SpanKind.SERVER }, async (span) => {
    try {
      const result = await authorizeInternal(event);
      // A Deny is this authorizer working, not failing — it is the designed
      // answer to a bad or absent token. The outcome is recorded as an
      // attribute so a denial is still findable in Jaeger, while ERROR stays
      // reserved for the authorizer itself breaking.
      span.setAttribute(
        "ws.authorization.effect",
        result.policyDocument.Statement[0].Effect,
      );
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      // Own span.end() + own flush: four bundles, no shared runtime. See
      // connect.ts. This one matters most of the four — the authorizer is
      // where a slow JWT verification hides, and it is invisible in the trace
      // without its span.
      span.end();
      await flushTraces();
    }
  });
}

async function authorizeInternal(
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
