import type { LoggerProvider } from '@opentelemetry/sdk-logs';
import type { Span } from '@opentelemetry/api';

import { APP_CONFIG } from '../config/app-config';

let started = false;
let loggerProvider: LoggerProvider | undefined;
let pageSpanAccessor: (() => Span | undefined) | undefined;
let pageSpanStarter: ((name: string) => void) | undefined;
let activePageRoute: string | undefined;

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
 * WHY: Exported so rum-propagation-interceptor.ts (always loaded) can LINK
 * its CLIENT span to the current page span WITHOUT statically importing
 * @opentelemetry/sdk-trace-web. Undefined both when the flag is off and
 * before rum-sdk.ts has started.
 */
export function getActivePageSpan(): Span | undefined {
  return pageSpanAccessor?.();
}

/**
 * WHY: The route PATTERN rum-navigation.ts resolved (`/orders/:orderId`), so
 * rum-propagation-interceptor.ts tags page.route without the Router or
 * location.pathname. Undefined before the first NavigationEnd.
 */
export function getActivePageRoute(): string | undefined {
  return activePageRoute;
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
  void import('./rum-sdk').then(({ startRumSdk, getActivePageSpan, startPageSpan }) => {
    loggerProvider = startRumSdk();
    pageSpanAccessor = getActivePageSpan;
    pageSpanStarter = startPageSpan;
    started = true;
  });
}
