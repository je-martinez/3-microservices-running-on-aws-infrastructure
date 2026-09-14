// Publishes a domain envelope onto the shared events topic — the REAL path a
// notification takes (topic → filter policy → notifications queue → the Users
// consumer), so a spec seeding rows through this exercises the SNS filter policy
// rather than reaching past it into the database.
//
// WORKAROUND(local): unsigned query-protocol POST, not @aws-sdk/client-sns. Floci
// accepts Publish with no Authorization header, and the suite carries no AWS SDK
// dependency — `support/events-queue-depth.ts` reads SQS the same way. Against real
// AWS this is rejected, which is correct: these specs are local-stack only.
// See [[testing]]

/** The attribute name the notifications subscription's filter policy matches on. */
const FILTER_ATTRIBUTE = "type";

/** The envelope fields the Users consumer's own schema requires. */
export interface EventEnvelope {
  event_id: string;
  type: string;
  source: string;
  user_id: string;
  order_id: string | null;
  author: { actor: string; user_id?: string; cognito_sub?: string };
  payload: Record<string, unknown>;
}

function topicArn(): string {
  const arn = process.env.EVENTS_TOPIC_ARN;
  if (!arn) {
    throw new Error(
      "EVENTS_TOPIC_ARN is not set — it is generated into .env.local.users by " +
        "`make bootstrap`, which playwright.config.ts loads.",
    );
  }
  return arn;
}

/** Floci's single endpoint. The SNS query protocol posts to the service root. */
function endpoint(): string {
  const queueUrl = process.env.NOTIFICATIONS_QUEUE_URL ?? "http://localhost:4566/";
  const url = new URL(queueUrl);
  return `${url.protocol}//${url.host}/`;
}

/**
 * CONTRACT: The `type` MESSAGE ATTRIBUTE is what routes the event, not the body.
 * The subscription uses raw message delivery, so SNS never inspects the payload —
 * an envelope published without this attribute reaches the events queue and is
 * silently absent from the notifications one, with a 200 at the publisher.
 * See [[2026-09-10-in-app-notifications-design]]
 */
export async function publishEvent(envelope: EventEnvelope): Promise<void> {
  const body = new URLSearchParams({
    Action: "Publish",
    Version: "2010-03-31",
    TopicArn: topicArn(),
    Message: JSON.stringify(envelope),
    [`MessageAttributes.entry.1.Name`]: FILTER_ATTRIBUTE,
    [`MessageAttributes.entry.1.Value.DataType`]: "String",
    [`MessageAttributes.entry.1.Value.StringValue`]: envelope.type,
  });

  const res = await fetch(endpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(
      `SNS Publish of ${envelope.type} failed: ${res.status} ${await res.text()}`,
    );
  }
}

let sequence = 0;

/** A unique event id per call, so the pipeline's idempotency key never collides. */
export function newEventId(): string {
  sequence += 1;
  return `evt_e2e${Date.now().toString(36)}${sequence}`;
}
