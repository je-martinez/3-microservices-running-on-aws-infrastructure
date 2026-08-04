import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { appLogger } from "#shared/logging/app-logger";
import { hashEmail } from "#shared/logging/email-hash";
import { generateId } from "#shared/id/nano-id";

// `fullName` is required by the pipeline: the events-pipeline USER_CREATED
// handler validates the payload with a Zod schema that requires BOTH `fullName`
// and `email` (functions/events-pipeline/src/handlers/user-created.ts), and the
// welcome template greets the user by name. Publishing `{ id, email }` alone
// would be rejected as a PermanentError on every single event, so the seam
// carries the name the consumer contract already demands.
export interface UserCreatedPayload {
  id: string;
  email: string;
  fullName: string;
}

export interface EventPublisher {
  publishUserCreated(payload: UserCreatedPayload): Promise<void>;
}

// Kept deliberately (it is NOT dead code): tests and any environment that must
// not emit register this instead of the SQS publisher.
export class NoopEventPublisher implements EventPublisher {
  async publishUserCreated(_payload: UserCreatedPayload): Promise<void> {
    return;
  }
}

const EVENT_ID_PREFIX = "evt_";
const EVENT_TYPE = "USER_CREATED";
const EVENT_SOURCE = "users";

// Real implementation. `event_id` is generated INSIDE the publisher so the seam
// signature stays untouched (the milestone design spec's preferred option). It
// is the pipeline's idempotency key: the events collection has a unique index
// on it, so an SQS redelivery of the same message collides and is treated as
// already-processed.
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publishUserCreated(payload: UserCreatedPayload): Promise<void> {
    // snake_case throughout — this is the wire contract validated by the
    // pipeline's EnvelopeSchema. `order_id` is NULLABLE, not optional, in that
    // schema: the key must be present with a null value or the envelope is
    // rejected.
    const envelope = {
      event_id: generateId(EVENT_ID_PREFIX),
      type: EVENT_TYPE,
      source: EVENT_SOURCE,
      user_id: payload.id,
      order_id: null,
      // Only what the handler's payload schema consumes. The user id already
      // travels as `user_id` on the envelope; repeating it here would put it in
      // the document the email is rendered from for no reason.
      payload: { email: payload.email, fullName: payload.fullName },
    };

    try {
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(envelope),
          // Duplicated as message attributes so the queue can be inspected
          // (and filtered) without deserializing the body.
          MessageAttributes: {
            type: { DataType: "String", StringValue: envelope.type },
            source: { DataType: "String", StringValue: envelope.source },
          },
        }),
      );
    } catch (err) {
      // DELIBERATE: swallowed, not rethrown. The user row and the Cognito
      // account already exist by the time this runs; failing the request here
      // would return an error for a registration that actually succeeded, and
      // the client's natural retry would hit `email_exists` (409) forever. The
      // welcome email is a secondary effect, so a queue outage degrades it
      // rather than breaking the flow — the same best-effort stance
      // register() already takes for the Cognito identity capture.
      //
      // NOT silent: it is logged at error with the `*_failed` app_event so it
      // is alertable. NEVER log the plaintext email — only `email_hash` and
      // `user_id` identify the user here.
      appLogger.error(
        {
          err,
          app_event: "user_created_publish_failed",
          reason: "sqs_send_failed",
          user_id: payload.id,
          email_hash: hashEmail(payload.email),
        },
        "USER_CREATED publish failed (non-fatal): the user was created but no event was emitted",
      );
    }
  }
}
