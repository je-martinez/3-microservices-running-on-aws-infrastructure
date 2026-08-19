import { type Context, type Span, context, trace } from "@opentelemetry/api";
import { RPCType, getRPCMetadata } from "@opentelemetry/core";
import type { FastifyRequest } from "fastify";

// Resolves the HTTP SERVER span of the current request — the span a human
// actually clicks in a trace waterfall ("POST /v1/users/register") — from
// inside a Fastify hook.
//
// WHY THIS EXISTS. `@fastify/otel` wraps EVERY Fastify hook in a span of its
// own ("onResponse - fastify -> @fastify/otel"). So inside the `onResponse`
// hook, `trace.getActiveSpan()` is the HOOK's span, not the request's, and the
// logger's formatter (shared/logging/logger.ts) stamps that hook span id onto
// the line. That silently broke the logs<->traces join for the single most
// useful line of the request: clicking the `POST /v1/users/register` span in
// OpenObserve and asking for its logs matched NOTHING, because `request
// completed` was filed under a hook span nobody ever clicks. Measured on a live
// 12-span trace: only 2 spans had any logs, and the request span was not one of
// them. Before @fastify/otel was added, the same line carried the POST span's
// id — this restores that.
//
// The span tree in this service, measured under `node --import` with the real
// SDK (auto-instrumentations + @fastify/otel), is three levels deep:
//
//   POST /v1/users/register        <- instrumentation-http, kind SERVER  <= WANTED
//     └── request                  <- @fastify/otel, kind INTERNAL
//           ├── handler - ...      <- @fastify/otel
//           └── onResponse - ...   <- @fastify/otel  <= where the log used to land
//
// So the target is TWO levels above the active span, and neither
// `trace.getActiveSpan()` nor `@fastify/otel`'s own request span is it.
//
// TWO SUBTLETIES, both measured rather than assumed:
//
// 1. `request.opentelemetry().context`, NOT `context.active()`. The decorator is
//    @fastify/otel's public, typed API and still holds the request's context in
//    `onResponse`; `context.active()` there is the hook's context, whose
//    RPC metadata lookup would still resolve — but relying on the request's own
//    context is what makes this independent of which hook we are called from.
//    Note `request.opentelemetry().span` is NOT usable: @fastify/otel nulls it
//    in `onSend`, which runs BEFORE `onResponse`, so it reads `null` here.
//
// 2. `getRPCMetadata` over the SDK-internal `parentSpanContext`. Walking the
//    request span's parent yields the same span, but `parentSpanContext` is an
//    SDK implementation detail, not public API. RPC metadata is the supported
//    channel instrumentation-http publishes its server span on, and it is the
//    same call @fastify/otel itself makes to detect an upstream server span.
//    Cross-version safe despite two @opentelemetry/core copies in the tree: the
//    context key is built with `createContextKey`, which is `Symbol.for`-based,
//    so every copy resolves the identical key.
//
// Returns `undefined` when there is no SDK running (the unit tests) or no HTTP
// server span — callers must fall back to logging as they otherwise would,
// never to a fabricated id.
export function getHttpServerSpan(request: FastifyRequest): Span | undefined {
  const requestContext = getRequestContext(request);
  if (requestContext === undefined) return undefined;

  const rpcMetadata = getRPCMetadata(requestContext);
  if (rpcMetadata?.type !== RPCType.HTTP) return undefined;

  return rpcMetadata.span;
}

// `request.opentelemetry()` only exists once @fastify/otel's plugin is
// registered on the instance. The unit suite builds the app with no SDK and no
// plugin, so the decorator is genuinely absent there — hence the feature test
// rather than a non-null assertion.
function getRequestContext(request: FastifyRequest): Context | undefined {
  const otel = (request as FastifyRequest & { opentelemetry?: () => { context?: Context } })
    .opentelemetry;
  if (typeof otel !== "function") return undefined;
  return otel.call(request).context ?? undefined;
}

// Runs `fn` with the request's HTTP server span active, so anything it logs is
// stamped with THAT span's id by the logger's formatter. A no-op passthrough
// when the span cannot be resolved — the line is still emitted, just without a
// span id, exactly as it would have been.
export function withHttpServerSpan<T>(request: FastifyRequest, fn: () => T): T {
  const span = getHttpServerSpan(request);
  if (span === undefined) return fn();
  return context.with(trace.setSpan(context.active(), span), fn);
}
