// Tracing FIRST — see the note at the top of connect.ts.
import { flushTraces, wsTracer } from "#shared/observability/tracing";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { APIGatewayProxyResult } from "aws-lambda";
import { deleteConnection } from "#shared/connections-repository";
import { logger } from "#shared/logging/logger";

interface DisconnectEvent {
  requestContext: { connectionId: string };
}

export async function handler(
  event: DisconnectEvent,
): Promise<APIGatewayProxyResult> {
  return wsTracer.startActiveSpan("ws_disconnect", { kind: SpanKind.SERVER }, async (span) => {
    try {
      const result = await disconnectInternal(event);
      span.setStatus({
        code: result.statusCode === 200 ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      // Own span.end() + own flush: four bundles, no shared runtime. See
      // connect.ts.
      span.end();
      await flushTraces();
    }
  });
}

async function disconnectInternal(
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
