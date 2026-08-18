import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { context, propagation } from "@opentelemetry/api";
import { appLogger } from "#shared/logging/app-logger";
import { hashEmail } from "#shared/logging/email-hash";
import { NanoIdConfig } from "#shared/id/nano-id";
import { AuditActor } from "#shared/audit/audit-actor";
import { getLogContext } from "#shared/logging/log-context";

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

// The seam for PASSWORD_RESET_REQUESTED. `code` is a LIVE CREDENTIAL travelling
// through this interface: it is the one thing the email exists to deliver, and
// the one thing that must never appear in a log line, an error message, or a
// persisted event document (the pipeline redacts it before storing — see
// `#domain/redact-payload` there).
//
// `fullName` mirrors USER_CREATED's requirement: the handler's Zod schema
// demands the key be present, and the template greets by name. It tolerates an
// empty string (a nameless greeting) rather than rejecting the envelope and
// costing the user their reset code over a missing greeting.
//
// `ttlSeconds` rides the seam instead of being hardcoded in the publisher
// because the value that must reach the email is the SAME one that decided the
// stored row's `expiresAt`. Passing it keeps a single source of truth: what the
// user reads is what the database will enforce, by construction.
export interface PasswordResetRequestedPayload {
  userId: string;
  email: string;
  fullName: string;
  code: string;
  ttlSeconds: number;
  cognitoSub?: string;
}

export interface EventPublisher {
  publishUserCreated(payload: UserCreatedPayload): Promise<void>;
  publishPasswordResetRequested(payload: PasswordResetRequestedPayload): Promise<void>;
}

// Kept deliberately (it is NOT dead code): tests and any environment that must
// not emit register this instead of the SQS publisher.
export class NoopEventPublisher implements EventPublisher {
  async publishUserCreated(_payload: UserCreatedPayload): Promise<void> {
    return;
  }

  async publishPasswordResetRequested(_payload: PasswordResetRequestedPayload): Promise<void> {
    return;
  }
}

// The prefix lives in NanoIdConfig with every other one; this file mints through
// `NanoIdConfig.newEventId()` rather than repeating the string.
const EVENT_TYPE = "USER_CREATED";
const PASSWORD_RESET_EVENT_TYPE = "PASSWORD_RESET_REQUESTED";
const EVENT_SOURCE = "users";

// The W3C trace context for the SQS hop, shaped as SQS message attributes.
//
// It rides in `MessageAttributes` and NEVER in the envelope: the body is a
// domain contract the pipeline validates with Zod, so an extra key there is
// either rejected or silently persisted as data. Transport metadata belongs on
// the transport, next to `type` and `source`.
//
// `propagation.inject` writes `traceparent` (plus `tracestate` when one exists)
// into the carrier ONLY when there is a valid active span; with no span in
// flight — a background task, a test, an SDK that never started — it writes
// nothing at all and this returns an empty object, so the key is OMITTED rather
// than sent blank. That distinction matters more than it looks: an all-zeros or
// empty traceparent still PARSES downstream, so the consumer would parent its
// span to a trace that does not exist and the cascade would break silently
// instead of simply being absent. Same "omitted, never null" rule the envelope's
// `request_id` and `author.cognito_sub` already follow — see [[logging-context]].
function traceparentAttributes(): Record<string, { DataType: "String"; StringValue: string }> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  return Object.fromEntries(
    Object.entries(carrier).map(([key, value]) => [
      key,
      { DataType: "String" as const, StringValue: value },
    ]),
  );
}

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
      event_id: NanoIdConfig.newEventId(),
      // The correlation id of the request that produced this event, so the
      // pipeline's log lines join back to the registration or reset that caused
      // them. OMITTED, never null, when there is no active context (a background
      // task, a test): the pipeline's schema declares it `.optional().min(1)`,
      // so an explicit null or "" is a PermanentError there — the message is not
      // retried and its email is lost. `undefined` is the right absence marker
      // because JSON.stringify drops it, exactly as `author.cognito_sub` below.
      request_id: getLogContext().request_id,
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
            ...traceparentAttributes(),
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

  // Emits the event whose ONLY consumer is the forgot-password email
  // (functions/events-pipeline/src/handlers/password-reset-requested.ts).
  //
  // The `payload` shape is fixed by that handler's Zod schema and is NOT ours to
  // restyle: exactly `{ email, full_name, code, ttlSeconds }`, including its
  // mixed casing (`full_name` snake, `ttlSeconds` camel). Renaming any of the
  // four would make every reset email fail validation as a PermanentError — the
  // message consumed, the document recorded FAILED, and the user simply never
  // receiving their code. The oddity is documented at the consumer; this side
  // just has to match it.
  //
  // No extra keys are added: this payload carries a live credential, and the
  // pipeline's redaction is keyed to the fields it knows about. Anything smuggled
  // in alongside would be persisted verbatim.
  async publishPasswordResetRequested(payload: PasswordResetRequestedPayload): Promise<void> {
    const envelope = {
      event_id: NanoIdConfig.newEventId(),
      // The correlation id of the request that produced this event, so the
      // pipeline's log lines join back to the registration or reset that caused
      // them. OMITTED, never null, when there is no active context (a background
      // task, a test): the pipeline's schema declares it `.optional().min(1)`,
      // so an explicit null or "" is a PermanentError there — the message is not
      // retried and its email is lost. `undefined` is the right absence marker
      // because JSON.stringify drops it, exactly as `author.cognito_sub` below.
      request_id: getLogContext().request_id,
      type: PASSWORD_RESET_EVENT_TYPE,
      source: EVENT_SOURCE,
      // The SUBJECT of the event: whose password is being reset.
      user_id: payload.userId,
      // Present-and-null, not omitted — the pipeline's EnvelopeSchema declares
      // `order_id` nullable rather than optional, so a missing key is rejected.
      order_id: null,
      // WHO originated it. A password reset is self-service, so author and
      // subject are the same person here — as with USER_CREATED, and unlike
      // events with no human author at all. `cognito_sub` is OMITTED when absent
      // (a user row can exist before its identity is captured), never null:
      // JSON.stringify drops undefined-valued properties, null would serialize.
      author: {
        actor: AuditActor.PasswordResetRequested,
        user_id: payload.userId,
        ...(payload.cognitoSub ? { cognito_sub: payload.cognitoSub } : {}),
      },
      payload: {
        email: payload.email,
        full_name: payload.fullName,
        code: payload.code,
        ttlSeconds: payload.ttlSeconds,
      },
    };

    try {
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(envelope),
          MessageAttributes: {
            type: { DataType: "String", StringValue: envelope.type },
            source: { DataType: "String", StringValue: envelope.source },
            ...traceparentAttributes(),
          },
        }),
      );
    } catch (err) {
      // Same best-effort stance as USER_CREATED, for the same reason: the code
      // row is already persisted when this runs, so rethrowing would report a
      // failure for a reset that is, on our side, entirely successful — and the
      // caller cannot tell the difference anyway, because the endpoint answers
      // identically whether or not the email exists (no enumeration). A queue
      // outage costs the user their email, not a broken flow.
      //
      // NEVER log the code (it is the credential) and NEVER the plaintext email:
      // only `email_hash` and `user_id` identify anyone here. `err` is a SQS SDK
      // error and carries none of the message body.
      appLogger.error(
        {
          err,
          app_event: "password_reset_requested_publish_failed",
          reason: "sqs_send_failed",
          user_id: payload.userId,
          email_hash: hashEmail(payload.email),
        },
        "PASSWORD_RESET_REQUESTED publish failed (non-fatal): the code was stored but no email was requested",
      );
    }
  }
}
