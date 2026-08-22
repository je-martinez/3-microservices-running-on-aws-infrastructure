// Tracing FIRST, above every other import: this bundle has no `node --import`
// step, so "runs first" is decided purely by import order in the entry file.
import { flushTraces, wsTracer } from "#shared/observability/tracing";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
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
  return wsTracer.startActiveSpan("ws_connect", { kind: SpanKind.SERVER }, async (span) => {
    try {
      const result = await connectInternal(event);
      span.setStatus({
        code: result.statusCode === 200 ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      // Both lines are load-bearing. A span not ended never reaches Jaeger, and
      // it does not show up as an error — it silently vanishes. And the flush
      // MUST be here, in THIS file: the four entry points compile into four
      // standalone bundles with no shared runtime, so there is nowhere central
      // to drain the batch before Lambda freezes the process.
      span.end();
      await flushTraces();
    }
  });
}

async function connectInternal(event: ConnectEvent): Promise<APIGatewayProxyResult> {
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
