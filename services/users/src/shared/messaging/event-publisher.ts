import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { appLogger } from "#shared/logging/app-logger";
import { hashEmail } from "#shared/logging/email-hash";
import { generateId } from "#shared/id/nano-id";
import { AuditActor } from "#shared/audit/audit-actor";

// `fullName` is required by the pipeline: the events-pipeline USER_CREATED
// handler validates the payload with a Zod schema that requires BOTH `fullName`
// and `email` (functions/events-pipeline/src/handlers/user-created.ts), and the
// welcome template greets the user by name. Publishing `{ id, email }` alone
// would be rejected as a PermanentError on every single event, so the seam
// carries the name the consumer contract already demands.
//
// `cognitoSub` is OPTIONAL on the seam, not on this path: register() has it in
// hand (the `signUp` response) and passes it. It stays optional because the
// envelope's `author` omits what it does not know rather than inventing it, so
// a future caller without a sub is expressible without a null creeping onto the
// wire.
//
// `createdAt` is REQUIRED because the rebranded welcome email renders a
// "Member Since" row from it: without it the template has nothing to print and
// the row comes out blank. It is the user row's own `createdAt` — the caller
// already holds the created row, so nothing here re-reads the database. A
// `Date` on the seam, an ISO-8601 string on the wire (see the payload built
// below): the conversion belongs to the publisher, which owns the wire
// contract, not to every caller.
export interface UserCreatedPayload {
  id: string;
  email: string;
  fullName: string;
  createdAt: Date;
  cognitoSub?: string;
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
      // WHO originated the event, as opposed to `user_id`, which is its
      // SUBJECT. The two coincide on this event (a self-registration) and do
      // not on others — TRACKING_STATUS_CHANGED has a subject but no human
      // author at all. `actor` is the same semantic `AuditActor` value already
      // stamped into `createdBy`/`updatedBy` for this write path, so an event
      // and the row it produced name their origin identically.
      //
      // No `author.source`: the producing service is already the envelope's
      // root `source` above, and a second copy inside `author` would carry no
      // information while inviting the two to disagree (see AuthorSchema in
      // functions/events-pipeline/src/domain/envelope.ts).
      //
      // `cognito_sub` is OMITTED when the caller did not supply one — the key
      // is absent from the JSON, never present-and-null. `undefined` is the
      // right absence marker here: `JSON.stringify` drops undefined-valued
      // properties, whereas `null` would serialize.
      author: {
        actor: AuditActor.Register,
        user_id: payload.id,
        ...(payload.cognitoSub ? { cognito_sub: payload.cognitoSub } : {}),
      },
      // Only what the handler's payload schema consumes — but the welcome
      // email is rendered from THIS object, so every row the template prints
      // has to be here.
      //
      // Casing: this payload is camelCase (`fullName`), unlike the snake_case
      // payloads Orders and Tracking publish. The new keys follow the payload
      // they join rather than the sibling services: renaming `fullName` would
      // break the consumer's Zod schema, and mixing `fullName` with
      // `created_at` in one object would leave a payload that is internally
      // inconsistent forever. One convention per payload beats one convention
      // per repo when the two conflict. (The ENVELOPE around it stays
      // snake_case — that contract is shared and unchanged.)
      //
      // `userId` is deliberately duplicated from the envelope's `user_id`. It
      // used to be omitted precisely BECAUSE it was already up there, but the
      // rebranded welcome email prints an "Account ID" row, and the renderer
      // reads the payload, not the envelope. Without it that row renders blank.
      //
      // `createdAt` feeds the "Member Since" row. Serialized as ISO-8601 here
      // (not left as a Date) so the wire value is an unambiguous string
      // regardless of how the consumer parses JSON — same shape `JSON.stringify`
      // would produce anyway, made explicit so it cannot drift if this object is
      // ever serialized by something else.
      payload: {
        email: payload.email,
        fullName: payload.fullName,
        userId: payload.id,
        createdAt: payload.createdAt.toISOString(),
      },
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
