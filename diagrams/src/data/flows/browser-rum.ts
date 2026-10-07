import type { FlowData } from "../../schema";

export const browserRum: FlowData = {
  title: "How browser telemetry reaches OpenObserve",
  subtitle: "Behind NG_APP_RUM_ENABLED; browser and backend spans share one trace_id",
  actors: [
    { id: "app", label: "Angular app", kind: "external" },
    { id: "sdk", label: "RUM SDK chunk", kind: "compute" },
    { id: "gateway", label: "API Gateway", kind: "edge", aws: "api-gateway" },
    { id: "nginx", label: "Web nginx", kind: "edge" },
    { id: "collector", label: "OTel collector", kind: "compute" },
    { id: "o2", label: "OpenObserve", kind: "data" },
  ],
  steps: [
    { from: "app", to: "sdk", label: "Lazy import", caption: "Only with the flag on; OTel stays out of the initial bundle" },
    { from: "sdk", to: "sdk", label: "Page span per route", caption: "Rotated on each NavigationEnd; page.route is the route pattern, never the URL" },
    { from: "app", to: "sdk", label: "CLIENT span per call", caption: "The interceptor on ApiClient calls asks for a root span, linked to the page span" },
    { from: "app", to: "gateway", label: "API call + traceparent", caption: "Backend spans continue the browser's trace; a raw fetch() gets no span at all" },
    { from: "app", to: "sdk", label: "Error to handler", caption: "RumErrorHandler emits an allow-listed log record: never bodies, tokens or emails" },
    { from: "sdk", to: "nginx", label: "OTLP, same origin", caption: "Batched traces, Web Vitals gauges and error logs go to the app's own /otlp path" },
    { from: "nginx", to: "collector", label: "Proxy to RUM port", caption: "nginx strips the prefix and forwards to the collector's browser-only receiver" },
    { from: "collector", to: "collector", label: "Mark RUM spans", caption: "Spans get telemetry.source = rum and a RUM - name prefix" },
    { from: "collector", to: "o2", label: "Three streams", caption: "Spans join app_traces beside the services'; vitals and errors go to rum_* streams" },
  ],
};
