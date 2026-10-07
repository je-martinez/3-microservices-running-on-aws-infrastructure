import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// WHY: local dev — the app and its lazy RUM chunk run in the browser; the web nginx, collector
// and OpenObserve run in Docker Compose; only the API Gateway is on Floci.
export const browserRum: z.input<typeof AwsDiagramData> = {
  title: "How browser telemetry reaches OpenObserve",
  subtitle: "Local dev, behind NG_APP_RUM_ENABLED; browser and backend spans share one trace_id",
  direction: "RIGHT",
  groups: [
    { id: "browser", kind: "corporate", label: "Browser" },
    { id: "floci", kind: "local-floci", label: "Floci (:4566)" },
    { id: "web", kind: "generic", label: "Docker Compose: web" },
    { id: "obs", kind: "generic", label: "Docker Compose: observability" },
  ],
  nodes: [
    { id: "app", label: "Angular app", icon: "client", group: "browser" },
    { id: "sdk", label: "RUM SDK chunk", icon: "client", group: "browser" },
    { id: "gateway", label: "API Gateway", icon: "api-gateway", group: "floci" },
    { id: "nginx", label: "Web nginx", sublabel: "/otlp", icon: "server", group: "web" },
    { id: "collector", label: "OTel collector", sublabel: "RUM receiver", icon: "server", group: "obs" },
    { id: "o2", label: "OpenObserve", icon: "data-table", group: "obs" },
  ],
  edges: [
    { id: "app-sdk", from: "app", to: "sdk", label: "spans, errors" },
    { id: "sdk-sdk", from: "sdk", to: "sdk", label: "page span" },
    { id: "app-gateway", from: "app", to: "gateway", label: "traceparent" },
    { id: "sdk-nginx", from: "sdk", to: "nginx", label: "OTLP" },
    { id: "nginx-collector", from: "nginx", to: "collector", label: "proxy" },
    { id: "collector-collector", from: "collector", to: "collector", label: "mark RUM" },
    { id: "collector-o2", from: "collector", to: "o2", label: "three streams" },
  ],
  steps: [
    { edges: ["app-sdk"], caption: "Only with the flag on; OTel stays out of the initial bundle" },
    { edges: ["sdk-sdk"], caption: "Rotated on each NavigationEnd; page.route is the route pattern, never the URL" },
    { edges: ["app-sdk"], caption: "The interceptor on ApiClient calls asks for a root span, linked to the page span" },
    { edges: ["app-gateway"], caption: "Backend spans continue the browser's trace; a raw fetch() gets no span at all" },
    { edges: ["app-sdk"], caption: "RumErrorHandler emits an allow-listed log record: never bodies, tokens or emails" },
    { edges: ["sdk-nginx"], caption: "Batched traces, Web Vitals gauges and error logs go to the app's own /otlp path" },
    { edges: ["nginx-collector"], caption: "nginx strips the prefix and forwards to the collector's browser-only receiver" },
    { edges: ["collector-collector"], caption: "Spans get telemetry.source = rum and a RUM - name prefix" },
    { edges: ["collector-o2"], caption: "Spans join app_traces beside the services'; vitals and errors go to rum_* streams" },
  ],
};
