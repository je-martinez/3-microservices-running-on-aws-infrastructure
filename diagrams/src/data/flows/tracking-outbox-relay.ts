import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// WHY: local dev — Tracking (API and its in-process poller) runs in Docker Compose; the MySQL
// cluster sits in module.networking's subnets on Floci, SNS/SQS/Lambda outside the VPC.
export const trackingOutboxRelay: z.input<typeof AwsDiagramData> = {
  title: "Tracking transactional outbox relay",
  subtitle: "Local dev: a status change commits with its outbox row; an in-process poller relays it to SNS",
  direction: "RIGHT",
  groups: [
    { id: "compose", kind: "generic", label: "Docker Compose: tracking" },
    { id: "floci", kind: "local-floci", label: "Floci (:4566)" },
    { id: "vpc", kind: "vpc", label: "VPC 10.0.0.0/16", parent: "floci" },
    { id: "subnets", kind: "public-subnet", label: "Subnets a + b", parent: "vpc" },
  ],
  nodes: [
    { id: "carrier", label: "Carrier", icon: "internet" },
    { id: "api", label: "Tracking API", icon: "server", group: "compose" },
    { id: "poller", label: "Outbox poller", sublabel: "in-process", icon: "server", group: "compose" },
    { id: "db", label: "Tracking DB", sublabel: "RDS MySQL", icon: "rds", group: "subnets" },
    { id: "topic", label: "Events topic", icon: "sns", group: "floci" },
    { id: "queue", label: "Events queue", icon: "sqs", group: "floci" },
    { id: "pipeline", label: "Events pipeline", icon: "lambda", group: "floci" },
  ],
  edges: [
    { id: "carrier-api", from: "carrier", to: "api", label: "status update", async: true },
    { id: "api-api", from: "api", to: "api", label: "bus pipeline" },
    { id: "api-db", from: "api", to: "db", label: "commit + outbox" },
    { id: "poller-db", from: "poller", to: "db", label: "claim / settle" },
    { id: "poller-poller", from: "poller", to: "poller", label: "discard" },
    { id: "poller-topic", from: "poller", to: "topic", label: "publish", async: true },
    { id: "topic-queue", from: "topic", to: "queue", label: "raw delivery", async: true },
    { id: "queue-pipeline", from: "queue", to: "pipeline", label: "batch", async: true },
  ],
  steps: [
    { edges: ["carrier-api"], caption: "The carrier webhook, or a TestMode progression, dispatches the update-status command" },
    { edges: ["api-api"], caption: "Tracing, app_event, logging and validation wrap the handler, outermost first" },
    { edges: ["api-db"], caption: "Status, history row and outbox message are written in one MySQL transaction" },
    { edges: ["poller-db"], caption: "Every 5 s each task claims up to 20 due rows with FOR UPDATE SKIP LOCKED" },
    { edges: ["poller-topic"], caption: "The stored payload becomes TRACKING_STATUS_CHANGED, its traceparent restored" },
    { edges: ["poller-db"], caption: "Delivered rows are deleted; the commit after publishing releases the row locks" },
    { edges: ["poller-db"], caption: "A failed publish keeps the row, bumps its attempts and backs off up to 5 minutes" },
    { edges: ["poller-poller"], caption: "A row at 12 attempts is deleted and logged at ERROR with its order id" },
    { edges: ["topic-queue"], caption: "The topic fans the event out to the events queue, body unchanged" },
    { edges: ["queue-pipeline"], caption: "At-least-once: the pipeline dedupes a re-publish on its event_id" },
  ],
};
