import type { FlowData } from "../../schema";

export const observabilityTelemetry: FlowData = {
  title: "How logs, traces and metrics reach OpenObserve",
  subtitle: "One OTel collector receives every signal; logs and traces join on trace_id",
  actors: [
    { id: "web", label: "Browser", kind: "external" },
    { id: "nginx", label: "Web nginx", kind: "edge" },
    { id: "services", label: "Services", kind: "compute", aws: "ecs" },
    { id: "lambdas", label: "Lambdas", kind: "compute", aws: "lambda" },
    { id: "cw", label: "CloudWatch", kind: "data" },
    { id: "collector", label: "OTel collector", kind: "compute" },
    { id: "o2", label: "OpenObserve", kind: "data" },
  ],
  steps: [
    { from: "web", to: "nginx", label: "RUM over OTLP", caption: "Browser spans, metrics and logs go same-origin; API calls carry a traceparent" },
    { from: "nginx", to: "collector", label: "Proxy to RUM port", caption: "nginx forwards to the collector's RUM receiver, which prefixes spans with RUM -" },
    { from: "services", to: "collector", label: "OTLP traces", caption: "Endpoint and protocol come from env vars only; each trace continues the browser's" },
    { from: "services", to: "collector", label: "JSON stdout", caption: "Docker's fluentd driver forwards every log line with the shared context fields" },
    { from: "lambdas", to: "cw", label: "Log lines", caption: "Lambda logs land in CloudWatch log groups on Floci, beside the RDS and nginx groups" },
    { from: "services", to: "cw", label: "Custom metrics", caption: "Business counters such as users_registered_total go to the 3MRAI namespace" },
    { from: "collector", to: "cw", label: "Poll each minute", caption: "The CloudWatch receiver autodiscovers log groups and queries the metrics" },
    { from: "collector", to: "collector", label: "Parse + route", caption: "JSON bodies are flattened; logs split into app, sql, redis, docdb, nginx and rds" },
    { from: "collector", to: "o2", label: "OTLP/HTTP export", caption: "Logs, traces and metrics land in OpenObserve streams, joined by trace_id" },
  ],
};
