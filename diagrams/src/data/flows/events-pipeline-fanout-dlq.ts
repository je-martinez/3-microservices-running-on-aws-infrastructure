import type { FlowData } from "../../schema";

export const eventsPipelineFanoutDlq: FlowData = {
  title: "Events fan-out, retries and the dead-letter queue",
  subtitle: "One SNS topic feeds two queues; both redrive to one shared DLQ",
  actors: [
    { id: "producers", label: "Services", kind: "compute", aws: "ecs" },
    { id: "topic", label: "Events topic", kind: "messaging", aws: "sns" },
    { id: "users-queue", label: "Users queue", kind: "messaging", aws: "sqs" },
    { id: "queue", label: "Events queue", kind: "messaging", aws: "sqs" },
    { id: "pipeline", label: "Events pipeline", kind: "compute", aws: "lambda" },
    { id: "store", label: "Events DB", kind: "data", aws: "documentdb" },
    { id: "dlq", label: "Shared DLQ", kind: "messaging", aws: "sqs" },
  ],
  steps: [
    { from: "producers", to: "topic", label: "Publish envelope", caption: "Users, Orders and Tracking publish one envelope; its type rides as an attribute", async: true },
    { from: "topic", to: "users-queue", label: "Filtered copy", caption: "Only the notification event types pass the filter policy into the Users queue", async: true },
    { from: "topic", to: "queue", label: "Raw delivery", caption: "Every event reaches the events queue, body byte-for-byte via raw delivery", async: true },
    { from: "queue", to: "pipeline", label: "Batch", caption: "The event source mapping delivers batches and accepts per-record failures", async: true },
    { from: "pipeline", to: "store", label: "Insert STARTED", caption: "The event is persisted before dispatch; a duplicate event_id is skipped" },
    { from: "pipeline", to: "pipeline", label: "Dispatch by type", caption: "The type picks one handler (SES email, WebSocket push); the event ends COMPLETED" },
    { from: "pipeline", to: "store", label: "Mark FAILED", caption: "A handler error marks FAILED; a transient one is returned for an SQS retry" },
    { from: "queue", to: "dlq", label: "Redrive", caption: "After 3 receives SQS moves the message to the DLQ; the Users queue does too", async: true },
    { from: "pipeline", to: "dlq", label: "Quarantine", caption: "A bad envelope, or a permanent failure with no document, is copied raw then ACKed", async: true },
  ],
};
