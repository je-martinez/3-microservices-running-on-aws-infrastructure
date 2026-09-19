import pino from "pino";
import { trace } from "@opentelemetry/api";
import { buildLoggerOptions } from "./logger.ts";

// Flow logs with no `req`: identity comes from AsyncLocalStorage log context.
// Environment falls back to "local" when loaded before AppConfigModule.
export const appLogger = pino(
  buildLoggerOptions({
    serviceName: "users",
    environment: process.env.DEPLOYMENT_ENVIRONMENT ?? "local",
  }),
);

// WHY: Interceptor suppresses a duplicate `*_failed` when the handler already
// logged one. Keyed by span object so concurrent requests do not share state.
const loggedEvents = new WeakMap<object, Set<string>>();

export function noteLoggedEvent(spanKey: object, appEvent: string): void {
  const events = loggedEvents.get(spanKey) ?? new Set<string>();
  events.add(appEvent);
  loggedEvents.set(spanKey, events);
}

export function hasLoggedEvent(spanKey: object, appEvent: string): boolean {
  return loggedEvents.get(spanKey)?.has(appEvent) ?? false;
}

function noteActiveSpanEvent(fields: unknown): void {
  if (!fields || typeof fields !== "object") return;
  const appEvent = (fields as { app_event?: unknown }).app_event;
  if (typeof appEvent !== "string") return;
  const span = trace.getActiveSpan();
  if (!span) return;
  noteLoggedEvent(span, appEvent);
}

const originalError = appLogger.error.bind(appLogger);
const originalWarn = appLogger.warn.bind(appLogger);

appLogger.error = ((...args: Parameters<typeof originalError>) => {
  noteActiveSpanEvent(args[0]);
  return originalError(...args);
}) as typeof appLogger.error;

appLogger.warn = ((...args: Parameters<typeof originalWarn>) => {
  noteActiveSpanEvent(args[0]);
  return originalWarn(...args);
}) as typeof appLogger.warn;
