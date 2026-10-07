import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: local dev. nginx, the services, the OTel collector and OpenObserve run in Docker
// Compose; the Lambdas and CloudWatch run on Floci. The CloudWatch edge points the way data
// travels: the collector polls it. Sources: docker-compose.yml, observability/otel-collector-config.yaml.
export const observabilityTelemetry: z.input<typeof AwsDiagramData> = {
  title: "How logs, traces and metrics reach OpenObserve",
  subtitle: "Local dev: one OTel collector receives every signal; logs and traces join on trace_id",
  direction: "RIGHT",
  groups: [
    { id: "compose-app", kind: "generic", label: "Docker Compose: app" },
    { id: "floci", kind: "local-floci", label: "Floci (:4566)" },
    { id: "compose-obs", kind: "generic", label: "Docker Compose: observability" },
  ],
  nodes: [
    { id: "web", label: "Browser", icon: "client" },
    { id: "nginx", label: "Web nginx", icon: "server", group: "compose-app" },
    { id: "services", label: "Services", sublabel: "Users, Orders, Tracking", icon: "server", group: "compose-app" },
    { id: "lambdas", label: "Lambdas", icon: "lambda", group: "floci" },
    { id: "cw", label: "CloudWatch", sublabel: "logs + metrics", icon: "cloudwatch", group: "floci" },
    { id: "collector", label: "OTel collector", icon: "server", group: "compose-obs" },
    { id: "o2", label: "OpenObserve", icon: "data-table", group: "compose-obs" },
  ],
  edges: [
    { id: "web-nginx", from: "web", to: "nginx", label: "RUM over OTLP" },
    { id: "nginx-collector", from: "nginx", to: "collector", label: "RUM port" },
    { id: "services-collector", from: "services", to: "collector", label: "traces + logs" },
    { id: "lambdas-cw", from: "lambdas", to: "cw", label: "log lines" },
    { id: "services-cw", from: "services", to: "cw", label: "custom metrics" },
    { id: "cw-collector", from: "cw", to: "collector", label: "polled each minute" },
    { id: "collector-o2", from: "collector", to: "o2", label: "OTLP/HTTP" },
  ],
  steps: [
    { edges: ["web-nginx"], caption: "Browser spans, metrics and logs go same-origin; API calls carry a traceparent" },
    { edges: ["nginx-collector"], caption: "nginx forwards to the collector's RUM receiver, which prefixes spans with RUM -" },
    { edges: ["services-collector"], caption: "Endpoint and protocol come from env vars only; each trace continues the browser's" },
    { edges: ["services-collector"], caption: "Docker's fluentd driver forwards every log line with the shared context fields" },
    { edges: ["lambdas-cw"], caption: "Lambda logs land in CloudWatch log groups on Floci, beside the RDS and nginx groups" },
    { edges: ["services-cw"], caption: "Business counters such as users_registered_total go to the 3MRAI namespace" },
    { edges: ["cw-collector"], caption: "The CloudWatch receiver autodiscovers log groups and queries the metrics" },
    { edges: ["collector-o2"], caption: "JSON bodies are flattened; logs split into app, sql, redis, docdb, nginx and rds" },
    { edges: ["collector-o2"], caption: "Logs, traces and metrics land in OpenObserve streams, joined by trace_id" },
  ],
};
