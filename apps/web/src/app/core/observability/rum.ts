import type { LoggerProvider } from '@opentelemetry/sdk-logs';
import type { Span } from '@opentelemetry/api';

import { APP_CONFIG } from '../config/app-config';

let started = false;
let loggerProvider: LoggerProvider | undefined;
let pageSpanAccessor: (() => Span | undefined) | undefined;
let pageSpanStarter: ((name: string) => void) | undefined;
let gatewaySpanStarter:
  | ((method: string, route: string, pageRoute: string | undefined) => GatewaySpan)
  | undefined;
let activePageRoute: string | undefined;

/**
 * CONTRACT: The CLIENT span of one gateway call, as rum-sdk.ts hands it to
 * the always-loaded interceptor. Call end() exactly once, after fail() if the
 * call failed — end() marks the span OK unless fail() ran first.
 */
export interface GatewaySpan {
  /** The W3C carrier (`traceparent`) to set on the outgoing request. */
  readonly headers: Readonly<Record<string, string>>;
  readonly traceId: string;
  run<T>(fn: () => T): T;
  fail(message: string): void;
  end(): void;
}

/**
 * WHY: Exported and read-only so specs and manual checks can assert whether
 * the SDK is up without reaching into module internals. True only once
 * rum-sdk.ts has actually finished starting, not merely once the import has
 * been kicked off.
 */
export function isRumStarted(): boolean {
  return started;
}

/**
 * WHY: Exported so rum-error-handler.ts obtains a logger without importing
 * the SDK's construction details, and returns undefined both when the flag is
 * off and before the lazily-loaded module has finished starting —
 * RumErrorHandler already treats undefined as "delegate only, do not report".
 */
export function getRumLoggerProvider(): LoggerProvider | undefined {
  return loggerProvider;
}

/**
 * WHY: Exported so specs can observe the current page span without importing
 * rum-sdk.ts. Undefined both when the flag is off and before rum-sdk.ts has
 * started.
 */
export function getActivePageSpan(): Span | undefined {
  return pageSpanAccessor?.();
}

/**
 * WHY: The route PATTERN rum-navigation.ts resolved (`/orders/:orderId`),
 * which startGatewaySpan() tags as page.route without the Router or
 * location.pathname. Undefined before the first NavigationEnd.
 */
export function getActivePageRoute(): string | undefined {
  return activePageRoute;
}

/**
 * CONTRACT: Returns undefined when the flag is off and until rum-sdk.ts has
 * started — the interceptor then sends the request untouched. Do NOT give
 * rum-propagation-interceptor.ts a value import from @opentelemetry/* to
 * fill that window: it is always loaded, and the import puts the OTel API
 * back into the initial bundle even with the flag off. See [[browser-rum]]
 */
export function startGatewaySpan(method: string, route: string): GatewaySpan | undefined {
  return gatewaySpanStarter?.(method, route, activePageRoute);
}

/**
 * CONTRACT: The only entry point rum-navigation.ts (Angular DI) calls on a
 * route change — it never imports rum-sdk.ts directly, so a navigation
 * before the SDK has loaded drops the span rather than triggering a second
 * dynamic import. The route is still recorded, so a call made in that window
 * carries page.route. See [[2026-09-19-web-rum-integration-design]]
 */
export function notifyPageChanged(name: string): void {
  activePageRoute = name;
  pageSpanStarter?.(name);
}

/**
 * CONTRACT: Called from main.ts BEFORE bootstrapApplication, at module scope,
 * and NEVER awaited there — document-load reads the Navigation Timing API, so
 * the SDK must be underway before the app starts rendering, but bootstrap
 * must not block on a ~239 kB dynamic import landing first. This function
 * stays synchronous up to the import() call for that reason; only the
 * lazily-loaded module's own startup happens after this returns.
 * See [[2026-09-19-web-rum-integration-design]]
 */
export function initRum(): void {
  if (!APP_CONFIG.rumEnabled) return;

  // WHY: Dynamic, never static — a static import pulls OTel and web-vitals
  // into the entry chunk for every visitor, including with the flag off.
  // See rum-sdk.ts.
  void import('./rum-sdk').then((sdk) => {
    loggerProvider = sdk.startRumSdk();
    pageSpanAccessor = sdk.getActivePageSpan;
    pageSpanStarter = sdk.startPageSpan;
    gatewaySpanStarter = sdk.startGatewaySpan;
    started = true;
  });
}
