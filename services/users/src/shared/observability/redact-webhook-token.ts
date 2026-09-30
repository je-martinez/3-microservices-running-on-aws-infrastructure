import type { Attributes, Span } from "@opentelemetry/api";
import type { IncomingMessage } from "node:http";

const WEBHOOK_PREFIX = "/v1/users/stripe/webhook/";

function decodedPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

// CONTRACT: The Stripe webhook's last path segment is a secret URL token. Every
// place that records the request URL (Fastify's `req` serializer, the HTTP
// server span, the @fastify/otel request span) must pass it through here, or
// the token lands in OpenObserve in clear. Match on the DECODED path: Fastify
// routes `/v1/users/%73tripe/webhook/<token>` to the same handler.
// See [[2026-09-19-stripe-payments-design]]
export function redactWebhookToken(url: string): string {
  const queryAt = url.indexOf("?");
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  if (!decodedPath(path).startsWith(WEBHOOK_PREFIX)) return url;
  return `${WEBHOOK_PREFIX}[REDACTED]${queryAt === -1 ? "" : url.slice(queryAt)}`;
}

// For instrumentation-http's `startIncomingSpanHook`: its return value is
// merged LAST into the span's start attributes, so the concrete URL is never
// recorded rather than overwritten after the fact.
export function redactIncomingSpanAttributes(request: IncomingMessage): Attributes {
  const url = request.url ?? "/";
  const redacted = redactWebhookToken(url);
  if (redacted === url) return {};
  const queryAt = redacted.indexOf("?");
  return {
    "http.target": redacted,
    "http.url": `http://${request.headers.host ?? "localhost"}${redacted}`,
    "url.path": queryAt === -1 ? redacted : redacted.slice(0, queryAt),
  };
}

// For @fastify/otel's `requestHook`, which records `url.path` as the raw
// `request.url` (query included).
export function redactFastifyRequestSpan(span: Span, request: { url: string }): void {
  const redacted = redactWebhookToken(request.url);
  if (redacted !== request.url) span.setAttribute("url.path", redacted);
}
