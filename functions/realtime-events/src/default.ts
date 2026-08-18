// Tracing FIRST — see the note at the top of connect.ts.
import { flushTraces, wsTracer } from "#shared/observability/tracing";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
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
  return wsTracer.startActiveSpan("ws_default", { kind: SpanKind.SERVER }, async (span) => {
    try {
      const result = await defaultInternal(event);
      // OK, despite the 400. The status describes THIS span's own execution,
      // and rejecting an inbound frame is this route's designed behaviour, not
      // a fault — marking it ERROR would light up every trace containing a
      // confused client as a failure.
      span.setStatus({ code: SpanStatusCode.OK });
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

async function defaultInternal(
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
