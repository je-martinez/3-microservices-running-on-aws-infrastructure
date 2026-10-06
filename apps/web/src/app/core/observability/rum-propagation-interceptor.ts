import { HttpErrorResponse, HttpEvent, HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { Observable } from 'rxjs';
import { finalize, tap } from 'rxjs/operators';

import { gatewayPath } from '../auth/auth-interceptor';
import { TRACE_ID_BY_RESPONSE } from '../http/api-client';
import { startGatewaySpan } from './rum';

/**
 * CONTRACT: Traces ONLY a gateway call (gatewayPath(...) !== null) — keeps
 * the /otlp export from tracing its own delivery. Do NOT enable XHR
 * auto-instrumentation "for completeness" — it doubles every request's spans
 * via propagateTraceHeaderCorsUrls. Do NOT import @opentelemetry/* here as a
 * value: this file is always loaded, so the span is built by rum-sdk.ts
 * through startGatewaySpan(), and a call made before that module has loaded
 * passes through untouched. See [[2026-09-19-web-rum-integration-design]]
 */
export function rumPropagationInterceptor(
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> {
  const route = gatewayPath(req.url);
  if (route === null) return next(req);

  const span = startGatewaySpan(req.method, route);
  if (!span) return next(req);

  return span.run(() =>
    next(req.clone({ setHeaders: span.headers })).pipe(
      tap({
        // WHY: This interceptor is LAST in the chain (closest to the
        // backend), so on the error path it sees the raw HttpErrorResponse
        // BEFORE ApiClient.mapError() converts it, one tick later and one
        // layer further out — too late to read the still-active span. It
        // records the id here, keyed to this exact response object, for
        // toApiError() to pick up when it builds the ApiError.
        error: (err: unknown) => {
          span.fail(err instanceof Error ? err.message : 'HTTP request failed');
          if (err instanceof HttpErrorResponse) {
            TRACE_ID_BY_RESPONSE.set(err, span.traceId);
          }
        },
      }),
      // WHY: finalize runs on the success, error AND unsubscribe path alike —
      // the one place guaranteed to end the span exactly once regardless of
      // outcome. end() keeps the ERROR status fail() set above.
      finalize(() => span.end()),
    ),
  );
}
