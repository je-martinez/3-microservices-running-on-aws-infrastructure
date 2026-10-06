import type { FlowData } from "../../schema";

export const trackingOutboxRelay: FlowData = {
  title: "Tracking transactional outbox relay",
  subtitle: "A status change commits with its outbox row; an in-process poller relays it to SNS",
  actors: [
    { id: "carrier", label: "Carrier", kind: "external" },
    { id: "api", label: "Tracking API", kind: "compute", aws: "ecs" },
    { id: "db", label: "Tracking DB", kind: "data", aws: "rds" },
    { id: "poller", label: "Outbox poller", kind: "compute", aws: "ecs" },
    { id: "topic", label: "Events topic", kind: "messaging", aws: "sns" },
    { id: "pipeline", label: "Events pipeline", kind: "compute", aws: "lambda" },
  ],
  steps: [
    { from: "carrier", to: "api", label: "Status update", caption: "The carrier webhook, or a TestMode progression, dispatches the update-status command" },
    { from: "api", to: "api", label: "Bus pipeline", caption: "Tracing, app_event, logging and validation wrap the handler, outermost first" },
    { from: "api", to: "db", label: "Commit + outbox", caption: "Status, history row and outbox message are written in one MySQL transaction" },
    { from: "poller", to: "db", label: "Claim batch", caption: "Every 5 s each task claims up to 20 due rows with FOR UPDATE SKIP LOCKED" },
    { from: "poller", to: "topic", label: "Publish", caption: "The stored payload becomes TRACKING_STATUS_CHANGED, its traceparent restored", async: true },
    { from: "poller", to: "db", label: "Delete row", caption: "Delivered rows are deleted; the commit after publishing releases the row locks" },
    { from: "poller", to: "db", label: "Reschedule", caption: "A failed publish keeps the row, bumps its attempts and backs off up to 5 minutes" },
    { from: "poller", to: "poller", label: "Discard", caption: "A row at 12 attempts is deleted and logged at ERROR with its order id" },
    { from: "topic", to: "pipeline", label: "Deliver", caption: "Delivery is at-least-once; the pipeline dedupes a re-publish on its event_id", async: true },
  ],
};
