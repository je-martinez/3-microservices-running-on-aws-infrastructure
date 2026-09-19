import { type Context, type Span, context, trace } from "@opentelemetry/api";
import { RPCType, getRPCMetadata } from "@opentelemetry/core";
import type { FastifyRequest } from "fastify";

// CONTRACT: Resolve the HTTP SERVER span via getRPCMetadata on request context so onResponse
// logs carry the root HTTP span ID instead of @fastify/otel's internal hook span ID.
// See [[logging-context]]
export function getHttpServerSpan(request: FastifyRequest): Span | undefined {
  const requestContext = getRequestContext(request);
  if (requestContext === undefined) return undefined;

  const rpcMetadata = getRPCMetadata(requestContext);
  if (rpcMetadata?.type !== RPCType.HTTP) return undefined;

  return rpcMetadata.span;
}

// Guard for request.opentelemetry decorator which is absent during unit tests.
function getRequestContext(request: FastifyRequest): Context | undefined {
  const otel = (request as FastifyRequest & { opentelemetry?: () => { context?: Context } })
    .opentelemetry;
  if (typeof otel !== "function") return undefined;
  return otel.call(request).context ?? undefined;
}

// Runs fn with the HTTP server span active so logs carry the root server span ID.
export function withHttpServerSpan<T>(request: FastifyRequest, fn: () => T): T {
  const span = getHttpServerSpan(request);
  if (span === undefined) return fn();
  return context.with(trace.setSpan(context.active(), span), fn);
}
