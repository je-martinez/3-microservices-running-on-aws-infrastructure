import { WebTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-web';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { trace, type Span, type Tracer } from '@opentelemetry/api';
import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';

let pageTracer: Tracer | undefined;
let activePageSpan: Span | undefined;
let awaitingFirstRoute = false;

/**
 * CONTRACT: Returns the in-flight page span, or undefined between navigations
 * and before the SDK has started. rum-propagation-interceptor.ts LINKS its
 * CLIENT span to this when present and omits the link otherwise — the
 * cross-service join rides on traceparent alone and must never regress on a
 * missing page span. See [[2026-09-19-web-rum-integration-design]]
 */
export function getActivePageSpan(): Span | undefined {
  return activePageSpan;
}

/**
 * CONTRACT: Ends the current page span exactly once — safe to call from more
 * than one trigger racing on the same navigation, because activePageSpan is
 * cleared synchronously here, not because Span.end() is itself idempotent.
 */
function endActivePageSpan(): void {
  if (!activePageSpan) return;
  activePageSpan.end();
  activePageSpan = undefined;
}

/**
 * CONTRACT: One page span per navigation, ended before the next starts — a
 * span left open across navigations would live as long as the tab stays on
 * that route, which for an idle cart or order-detail page can be hours, and
 * OTel does not export an unfinished span. Call on the initial load AND on
 * every Angular Router NavigationEnd; rum-navigation.ts is the only caller.
 * See [[2026-09-19-web-rum-integration-design]]
 */
export function startPageSpan(name: string): void {
  // CONTRACT: The FIRST call after startRumSdk() renames the bootstrap span
  // rather than replacing it — Router's initial NavigationEnd describes the
  // same page view, so a second span splits that view in two and orphans
  // document-load's children.
  if (awaitingFirstRoute && activePageSpan) {
    awaitingFirstRoute = false;
    activePageSpan.updateName(name);
    return;
  }
  awaitingFirstRoute = false;
  endActivePageSpan();
  if (!pageTracer) return;
  activePageSpan = pageTracer.startSpan(name);
}

/**
 * CONTRACT: This module holds every OTel and web-vitals import — ~239 kB raw
 * before this split shipped to every visitor regardless of the RUM flag,
 * blowing the initial bundle budget by 173.55 kB. rum.ts reaches this only
 * through a dynamic import(), never a static one, or the split does nothing.
 * See [[2026-09-19-web-rum-integration-design]]
 */
export function startRumSdk(): LoggerProvider {
  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: '3mrai-web' }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: '/otlp/v1/traces' })),
    ],
  });

  provider.register();

  new DocumentLoadInstrumentation().enable();

  // CONTRACT: Started AFTER provider.register() — trace.getTracer() resolves
  // through the global TracerProvider, so a tracer fetched before this would
  // be a stale reference to the no-op implementation.
  pageTracer = trace.getTracer('3mrai-web-page');

  // WHY: location.pathname here and the route pattern everywhere else — this
  // runs before bootstrapApplication, with no Router to resolve a pattern
  // from. The flag makes Router's first NavigationEnd rename this span
  // instead of starting a second one. See rum-navigation.ts.
  startPageSpan(location.pathname);
  awaitingFirstRoute = true;

  // CONTRACT: visibilitychange -> hidden and pagehide are independent
  // backstops for the same span — Angular's Router never fires for a tab
  // close or backgrounding, so without these the last page span of a session
  // never ends and never exports. endActivePageSpan() is safe to call from
  // both: it clears the module-level reference before returning, so whichever
  // fires first wins and the other is a no-op.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') endActivePageSpan();
  });
  window.addEventListener('pagehide', () => endActivePageSpan());

  const meterProvider = new MeterProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: '3mrai-web' }),
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: '/otlp/v1/metrics' }),
      }),
    ],
  });
  const meter = meterProvider.getMeter('3mrai-web-vitals');
  const gauges = new Map<string, ReturnType<typeof meter.createGauge>>();

  // CONTRACT: Report from web-vitals' own per-metric callback, plus a flush on
  // visibilitychange -> hidden — NOT on an arbitrary timer. LCP finalises at
  // first interaction, CLS accumulates over the tab's lifetime, INP only
  // exists after interaction; sending on a timer publishes provisional values
  // that look like good data. visibilitychange -> hidden is the only
  // reliable moment on mobile, where unload does not fire.
  // See [[2026-09-19-web-rum-integration-design]]
  const reportVital = (metric: Metric): void => {
    let gauge = gauges.get(metric.name);
    if (!gauge) {
      gauge = meter.createGauge(`web_vitals_${metric.name.toLowerCase()}`);
      gauges.set(metric.name, gauge);
    }
    gauge.record(metric.value, { rating: metric.rating });
  };

  onLCP(reportVital);
  onCLS(reportVital);
  onINP(reportVital);
  onTTFB(reportVital);
  onFCP(reportVital);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void meterProvider.forceFlush();
  });

  return new LoggerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: '3mrai-web' }),
    processors: [
      new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: '/otlp/v1/logs' }) }),
    ],
  });
}
