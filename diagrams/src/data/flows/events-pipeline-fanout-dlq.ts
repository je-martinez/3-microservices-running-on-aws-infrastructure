import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// WHY: local dev — the producers run in Docker Compose; DocumentDB sits in module.networking's
// subnets on Floci; SNS, both queues, the DLQ and the Lambda are regional (infra/modules/messaging).
export const eventsPipelineFanoutDlq: z.input<typeof AwsDiagramData> = {
  title: "Events fan-out, retries and the dead-letter queue",
  subtitle: "Local dev: one SNS topic feeds two queues; both redrive to one shared DLQ",
  direction: "RIGHT",
  groups: [
    { id: "compose", kind: "generic", label: "Docker Compose: services" },
    { id: "floci", kind: "local-floci", label: "Floci (:4566)" },
    { id: "vpc", kind: "vpc", label: "VPC 10.0.0.0/16", parent: "floci" },
    { id: "subnets", kind: "public-subnet", label: "Subnets a + b", parent: "vpc" },
  ],
  nodes: [
    { id: "producers", label: "Services", sublabel: "Users, Orders, Tracking", icon: "server", group: "compose" },
    { id: "topic", label: "Events topic", icon: "sns", group: "floci" },
    { id: "users-queue", label: "Users queue", sublabel: "notifications", icon: "sqs", group: "floci" },
    { id: "queue", label: "Events queue", icon: "sqs", group: "floci" },
    { id: "pipeline", label: "Events pipeline", icon: "lambda", group: "floci" },
    { id: "store", label: "Events DB", sublabel: "DocumentDB", icon: "documentdb", group: "subnets" },
    { id: "dlq", label: "Shared DLQ", icon: "sqs", group: "floci" },
  ],
  edges: [
    { id: "producers-topic", from: "producers", to: "topic", label: "publish", async: true },
    { id: "topic-users-queue", from: "topic", to: "users-queue", label: "filtered", async: true },
    { id: "topic-queue", from: "topic", to: "queue", label: "raw delivery", async: true },
    { id: "queue-pipeline", from: "queue", to: "pipeline", label: "batch", async: true },
    { id: "pipeline-store", from: "pipeline", to: "store", label: "status" },
    { id: "pipeline-pipeline", from: "pipeline", to: "pipeline", label: "dispatch" },
    { id: "queue-dlq", from: "queue", to: "dlq", label: "redrive", async: true },
    { id: "users-queue-dlq", from: "users-queue", to: "dlq", label: "redrive", async: true },
    { id: "pipeline-dlq", from: "pipeline", to: "dlq", label: "quarantine", async: true },
  ],
  steps: [
    { edges: ["producers-topic"], caption: "Users, Orders and Tracking publish one envelope; its type rides as an attribute" },
    { edges: ["topic-users-queue"], caption: "Only the notification event types pass the filter policy into the Users queue" },
    { edges: ["topic-queue"], caption: "Every event reaches the events queue, body byte-for-byte via raw delivery" },
    { edges: ["queue-pipeline"], caption: "The event source mapping delivers batches and accepts per-record failures" },
    { edges: ["pipeline-store"], caption: "The event is persisted before dispatch; a duplicate event_id is skipped" },
    { edges: ["pipeline-pipeline"], caption: "The type picks one handler (SES email, WebSocket push); the event ends COMPLETED" },
    { edges: ["pipeline-store"], caption: "A handler error marks FAILED; a transient one is returned for an SQS retry" },
    { edges: ["queue-dlq", "users-queue-dlq"], caption: "After 3 receives SQS moves the message to the DLQ; the Users queue does too" },
    { edges: ["pipeline-dlq"], caption: "A bad envelope, or a permanent failure with no document, is copied raw then ACKed" },
  ],
};
