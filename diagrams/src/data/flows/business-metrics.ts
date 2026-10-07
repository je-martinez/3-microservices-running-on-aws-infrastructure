import type { FlowData } from "../../schema";

export const businessMetrics: FlowData = {
  title: "How business metrics reach the dashboard",
  subtitle: "Services publish to CloudWatch; the collector polls it into OpenObserve",
  actors: [
    { id: "services", label: "Service pollers", kind: "compute", aws: "ecs" },
    { id: "rule", label: "Minute rule", kind: "messaging", aws: "eventbridge" },
    { id: "lambda", label: "Email Lambda", kind: "compute", aws: "lambda" },
    { id: "cw", label: "CloudWatch", kind: "data" },
    { id: "collector", label: "OTel collector", kind: "compute" },
    { id: "o2", label: "OpenObserve", kind: "data" },
  ],
  steps: [
    { from: "services", to: "services", label: "Count rows every 60s", caption: "Users, Orders and Tracking count their own tables: gauges, not counters" },
    { from: "services", to: "cw", label: "PutMetricData", caption: "One 3MRAI namespace; totals are their own ALL series, as Floci never aggregates" },
    { from: "services", to: "cw", label: "Seed counters at 0", caption: "Error and business counters get a 0 each tick so a quiet panel reads 0, not an error" },
    { from: "rule", to: "lambda", label: "Tick, rate(1 minute)", caption: "A Lambda has no loop of its own, so an EventBridge rule supplies the clock", async: true },
    { from: "lambda", to: "cw", label: "Email counters", caption: "emails_sent_total and emails_failed_total on each send, seeded at 0 on every tick" },
    { from: "collector", to: "cw", label: "GetMetricData each 60s", caption: "Each query names the exact dimension set; the period matches the publishers' 60s" },
    { from: "collector", to: "collector", label: "Collapse start time", caption: "One series per metric instead of one per scrape, applied before batching" },
    { from: "collector", to: "o2", label: "OTLP to metrics", caption: "One stream per metric, such as amazonaws_com_3mrai_orders_total, read by dashboard cards" },
  ],
};
