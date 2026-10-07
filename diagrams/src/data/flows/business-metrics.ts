import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// WHY: local dev — the services and the observability stack (collector, OpenObserve) run in
// Docker Compose; the EventBridge rule, the Lambda and CloudWatch are regional on Floci.
export const businessMetrics: z.input<typeof AwsDiagramData> = {
  title: "How business metrics reach the dashboard",
  subtitle: "Local dev: services publish to CloudWatch; the collector polls it into OpenObserve",
  direction: "RIGHT",
  groups: [
    { id: "compose", kind: "generic", label: "Docker Compose: services" },
    { id: "floci", kind: "local-floci", label: "Floci (:4566)" },
    { id: "obs", kind: "generic", label: "Docker Compose: observability" },
  ],
  nodes: [
    { id: "services", label: "Service pollers", sublabel: "Users, Orders, Tracking", icon: "server", group: "compose" },
    { id: "rule", label: "Minute rule", icon: "eventbridge", group: "floci" },
    { id: "lambda", label: "Email Lambda", sublabel: "events-pipeline", icon: "lambda", group: "floci" },
    { id: "cw", label: "CloudWatch", sublabel: "3MRAI namespace", icon: "cloudwatch", group: "floci" },
    { id: "collector", label: "OTel collector", icon: "server", group: "obs" },
    { id: "o2", label: "OpenObserve", icon: "data-table", group: "obs" },
  ],
  edges: [
    { id: "services-services", from: "services", to: "services", label: "count rows" },
    { id: "services-cw", from: "services", to: "cw", label: "PutMetricData" },
    { id: "rule-lambda", from: "rule", to: "lambda", label: "tick", async: true },
    { id: "lambda-cw", from: "lambda", to: "cw", label: "email counters" },
    { id: "collector-cw", from: "collector", to: "cw", label: "GetMetricData" },
    { id: "collector-collector", from: "collector", to: "collector", label: "collapse" },
    { id: "collector-o2", from: "collector", to: "o2", label: "OTLP" },
  ],
  steps: [
    { edges: ["services-services"], caption: "Users, Orders and Tracking count their own tables every 60s: gauges, not counters" },
    { edges: ["services-cw"], caption: "One 3MRAI namespace; totals are their own ALL series, as Floci never aggregates" },
    { edges: ["services-cw"], caption: "Error and business counters get a 0 each tick so a quiet panel reads 0, not an error" },
    { edges: ["rule-lambda"], caption: "A Lambda has no loop of its own, so an EventBridge rule supplies the clock" },
    { edges: ["lambda-cw"], caption: "emails_sent_total and emails_failed_total on each send, seeded at 0 on every tick" },
    { edges: ["collector-cw"], caption: "Each query names the exact dimension set; the period matches the publishers' 60s" },
    { edges: ["collector-collector"], caption: "One series per metric instead of one per scrape, applied before batching" },
    { edges: ["collector-o2"], caption: "One stream per metric, such as amazonaws_com_3mrai_orders_total, read by dashboard cards" },
  ],
};
