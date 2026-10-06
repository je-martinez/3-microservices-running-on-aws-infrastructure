import type { CatalogEntry } from "../catalog";
import { eventsPipelineFanoutDlq } from "./flows/events-pipeline-fanout-dlq";
import { trackingOutboxRelay } from "./flows/tracking-outbox-relay";
import { websocketLifecycle } from "./flows/websocket-lifecycle";

export const eventsFlowEntries: CatalogEntry[] = [
  {
    id: "tracking-outbox-relay",
    title: trackingOutboxRelay.title,
    primitive: "flow",
    output: "docs/domains/tracking/specs/diagrams/tracking-outbox-relay",
    watches: ["services/tracking-go/internal/outbox/**", "services/tracking-go/internal/bus/**", "services/tracking-go/internal/app/update_status.go"],
    data: trackingOutboxRelay,
  },
  {
    id: "events-pipeline-fanout-dlq",
    title: eventsPipelineFanoutDlq.title,
    primitive: "flow",
    output: "docs/domains/events-pipeline/specs/diagrams/events-pipeline-fanout-dlq",
    watches: ["functions/events-pipeline/src/**", "infra/modules/messaging/**", "infra/modules/lambda/**"],
    data: eventsPipelineFanoutDlq,
  },
  {
    id: "websocket-lifecycle",
    title: websocketLifecycle.title,
    primitive: "flow",
    output: "docs/infrastructure/specs/diagrams/websocket-lifecycle",
    watches: [
      "functions/realtime-events/**",
      "infra/modules/api-gateway-ws/**",
      "functions/events-pipeline/src/shared/realtime/**",
    ],
    data: websocketLifecycle,
  },
];
