import { HttpErrorResponse, HttpEvent, HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { Observable } from 'rxjs';
import { finalize, tap } from 'rxjs/operators';
import { propagation, context, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

import { gatewayPath } from '../auth/auth-interceptor';
import { TRACE_ID_BY_RESPONSE } from '../http/api-client';
import { getActivePageSpan } from './rum';

const tracer = trace.getTracer('3mrai-web');

// WHY: Inlined rather than imported from @opentelemetry/semantic-conventions
// — that package's tree-shaking left ~25 kB in the initial bundle for two
// string constants, on a module every visitor loads regardless of the RUM
// flag. Values match ATTR_HTTP_REQUEST_METHOD / ATTR_HTTP_ROUTE there.
const ATTR_HTTP_REQUEST_METHOD = 'http.request.method';
const ATTR_HTTP_ROUTE = 'http.route';

/**
 * CONTRACT: Starts a CLIENT span and injects its traceparent ONLY on a
 * gateway call (gatewayPath(...) !== null) — keeps the /otlp export from
 * tracing its own delivery. Do NOT enable XHR auto-instrumentation "for
 * completeness" — it doubles every request's spans via
 * propagateTraceHeaderCorsUrls. Parents off getActivePageSpan() via an
 * EXPLICIT parent context on startSpan, never ambient context.with() around
 * the app; with no page span (flag off, SDK not yet loaded) it parents off
 * context.active() instead — a missing page span degrades the RUM waterfall
 * grouping, never the traceparent injection the cross-service join depends
 * on. See [[2026-09-19-web-rum-integration-design]]
 */
export function rumPropagationInterceptor(
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> {
  const route = gatewayPath(req.url);
  if (route === null) return next(req);

  const pageSpan = getActivePageSpan();
  const parentContext = pageSpan ? trace.setSpan(context.active(), pageSpan) : context.active();

  const span = tracer.startSpan(
    `${req.method} ${route}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [ATTR_HTTP_REQUEST_METHOD]: req.method,
        // WHY: The route, never req.url — the full URL can carry a query
        // string, and [[logging-context]] forbids leaking identifying values
        // through telemetry attributes.
        [ATTR_HTTP_ROUTE]: route,
      },
    },
    parentContext,
  );
  const spanContext = trace.setSpan(context.active(), span);

  const carrier: Record<string, string> = {};
  propagation.inject(spanContext, carrier);

  let failed = false;

  return context.with(spanContext, () =>
    next(req.clone({ setHeaders: carrier })).pipe(
      tap({
        // WHY: This interceptor is LAST in the chain (closest to the
        // backend), so on the error path it sees the raw HttpErrorResponse
        // BEFORE ApiClient.mapError() converts it, one tick later and one
        // layer further out — too late to read the still-active span. It
        // records the id here, keyed to this exact response object, for
        // toApiError() to pick up when it builds the ApiError.
        error: (err: unknown) => {
          failed = true;
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : 'HTTP request failed',
          });
          if (err instanceof HttpErrorResponse) {
            TRACE_ID_BY_RESPONSE.set(err, span.spanContext().traceId);
          }
        },
      }),
      // WHY: finalize runs on the success, error AND unsubscribe path alike —
      // the one place guaranteed to end the span exactly once regardless of
      // outcome. The `failed` flag is what stops this from overwriting the
      // ERROR status tap's error handler already set above.
      finalize(() => {
        if (!failed) span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      }),
    ),
  );
}
