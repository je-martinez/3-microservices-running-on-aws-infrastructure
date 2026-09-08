import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { context, propagation } from "@opentelemetry/api";
import { appLogger } from "#shared/logging/app-logger";
import { hashEmail } from "#shared/logging/email-hash";
import { NanoIdConfig } from "#shared/id/nano-id";
import { AuditActor } from "#shared/audit/audit-actor";
import { getLogContext } from "#shared/logging/log-context";
import { withPublishSpan } from "#shared/observability/publish-tracing";

// CONTRACT: `fullName` and `createdAt` are required by the events-pipeline
// USER_CREATED handler's Zod schema and by the welcome template ("Member Since").
// Dropping either is a PermanentError on every event, or a blank row in the email.
// `cognitoSub` stays optional so the envelope's `author` can omit what it does not
// know rather than putting a null on the wire.
// See [[audit-fields]]
export interface UserCreatedPayload {
  id: string;
  email: string;
  fullName: string;
  createdAt: Date;
  cognitoSub?: string;
}

// WARNING: `code` is a LIVE CREDENTIAL on this seam. Never log it, never put it in
// an error message; the pipeline redacts it before persisting the event document.
// CONTRACT: `fullName` must be present (empty string is fine — a nameless greeting
// beats losing the reset code), and `ttlSeconds` rides the seam so the email quotes
// the same expiry the stored row enforces.
// See [[logging-context]]
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

// CONTRACT: The W3C trace context rides in `MessageAttributes`, NEVER in the
// envelope — the body is a Zod-validated domain contract, so an extra key there is
// rejected or silently persisted as data. Call this INSIDE `withPublishSpan`:
// `propagation.inject` reads the ACTIVE span, so one line earlier it stamps the
// enclosing workflow span and the pipeline's work hangs beside the publish instead
// of under it — silently, since that traceparent is still valid. With no active
// span it writes nothing, so the key is omitted rather than sent blank; an empty
// traceparent still parses downstream and parents onto a trace that never existed.
// See [[logging-context]]

// WARNING: In production this value is overwritten. @opentelemetry/instrumentation-aws-sdk
// injects into the same MessageAttributes object from its own `<queue> send` span, so the
// id on the wire is the SDK span's. Keep this anyway: that span is a CHILD of the publish
// span (identical subtree), and this is the only injection left if the aws-sdk
// instrumentation is ever disabled or fails to patch.
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

// CONTRACT: `event_id` is the pipeline's idempotency key — the events collection
// has a unique index on it, so an SQS redelivery collides and is treated as
// already-processed. Minted inside the publisher so the seam signature is untouched.
// See [[nano-id]]
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publishUserCreated(payload: UserCreatedPayload): Promise<void> {
    // Read ONCE: both correlation fields come from the same store, and a per-field
    // read lets them disagree if a continuation enriches the context between them.
    const logCtx = getLogContext();
    // CONTRACT: snake_case throughout — this is the wire contract the pipeline's
    // EnvelopeSchema validates. `order_id` is NULLABLE, not optional: the key must be
    // present with a null value or the envelope is rejected.
    const envelope = {
      event_id: NanoIdConfig.newEventId(),
      // CONTRACT: Omit `request_id`, never send null or "". The pipeline declares it
      // `.optional().min(1)`, so an empty value is a PermanentError: the message is
      // not retried and its email is lost. `undefined` is the marker — JSON.stringify
      // drops it. See [[logging-context]]
      request_id: logCtx.request_id,
      // CONTRACT: E2E only, and spread-or-nothing for the same reason as
      // `request_id` above — a null or "" run_id is a PermanentError at the pipeline.
      ...(logCtx.run_id ? { run_id: logCtx.run_id } : {}),
      type: EVENT_TYPE,
      source: EVENT_SOURCE,
      user_id: payload.id,
      order_id: null,
      // CONTRACT: `author` is WHO originated the event; the root `user_id` is its
      // SUBJECT (the same person here, not on every event). Do NOT add `author.source`
      // — the envelope's root `source` already carries it and two copies drift. Omit
      // `cognito_sub` when absent, never null.
      // See [[audit-fields]]
      author: {
        actor: AuditActor.Register,
        user_id: payload.id,
        ...(payload.cognitoSub ? { cognito_sub: payload.cognitoSub } : {}),
      },
      // CONTRACT: This payload is camelCase, unlike the snake_case ones Orders and
      // Tracking publish — renaming `fullName` breaks the consumer's Zod schema, and
      // mixing casings in one object is worse than the inconsistency. The ENVELOPE
      // around it stays snake_case. The welcome email renders from THIS object, so
      // `userId` is duplicated from the envelope and `createdAt` serialized ISO-8601
      // here; drop either and the "Account ID" / "Member Since" rows come out blank.
      payload: {
        email: payload.email,
        fullName: payload.fullName,
        userId: payload.id,
        createdAt: payload.createdAt.toISOString(),
      },
    };

    // Everything below runs inside the PRODUCER span, so the traceparent names the
    // publish and both log lines carry its span_id.
    await withPublishSpan(EVENT_TYPE.toLowerCase(), async (span) => {
      try {
        await this.client.send(
          new SendMessageCommand({
            QueueUrl: this.queueUrl,
            MessageBody: JSON.stringify(envelope),
            // Duplicated as message attributes so the queue can be inspected and
            // filtered without deserializing the body.
            MessageAttributes: {
              type: { DataType: "String", StringValue: envelope.type },
              source: { DataType: "String", StringValue: envelope.source },
              // CONTRACT: Built HERE, inside the span — see traceparentAttributes.
              ...traceparentAttributes(),
            },
          }),
        );

        // WARNING: Never log the plaintext email — `email_hash` identifies the
        // recipient without carrying PII. This is the span's own line, so "View logs"
        // on it answers and a missing welcome email is diagnosable from this side.
        // See [[logging-context]]
        appLogger.info(
          {
            app_event: "user_created_published",
            event_type: envelope.type,
            event_id: envelope.event_id,
            user_id: payload.id,
            email_hash: hashEmail(payload.email),
          },
          "USER_CREATED published",
        );
      } catch (err) {
        // CONTRACT: Mark the span failed — the send is swallowed below, so this is
        // the only place the failure stays visible in the trace.
        span.markFailed(err);

        // CONTRACT: Swallow, do NOT rethrow. The user row and Cognito account already
        // exist, so failing here reports an error for a registration that succeeded and
        // the client's retry hits `email_exists` (409) forever. Not silent: logged at
        // error with a `*_failed` app_event so it stays alertable.
        // WARNING: Never log the plaintext email — only `email_hash` and `user_id`.
        // See [[logging-context]]
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
    });
  }

  // CONTRACT: The payload is exactly `{ email, full_name, code, ttlSeconds }`,
  // mixed casing included — the consumer's Zod schema fixes it, and renaming any of
  // the four makes every reset email a PermanentError: message consumed, document
  // FAILED, user never gets their code. Add NO extra keys: this payload carries a
  // live credential and the pipeline's redaction only knows these fields, so anything
  // smuggled alongside is persisted verbatim.
  async publishPasswordResetRequested(payload: PasswordResetRequestedPayload): Promise<void> {
    // One read, for the reason given in publishUserCreated above.
    const logCtx = getLogContext();
    const envelope = {
      event_id: NanoIdConfig.newEventId(),
      // CONTRACT: Omit `request_id`, never send null or "". The pipeline declares it
      // `.optional().min(1)`, so an empty value is a PermanentError: the message is
      // not retried and its email is lost. `undefined` is the marker — JSON.stringify
      // drops it. See [[logging-context]]
      request_id: logCtx.request_id,
      // CONTRACT: E2E only, and spread-or-nothing for the same reason as
      // `request_id` above — a null or "" run_id is a PermanentError at the pipeline.
      ...(logCtx.run_id ? { run_id: logCtx.run_id } : {}),
      type: PASSWORD_RESET_EVENT_TYPE,
      source: EVENT_SOURCE,
      // The SUBJECT of the event: whose password is being reset.
      user_id: payload.userId,
      // CONTRACT: Present-and-null, not omitted — EnvelopeSchema declares `order_id`
      // nullable rather than optional, so a missing key is rejected.
      order_id: null,
      // CONTRACT: `author` is WHO originated it (self-service here, so it matches the
      // subject). Omit `cognito_sub` when absent, never null.
      // See [[audit-fields]]
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

    await withPublishSpan(PASSWORD_RESET_EVENT_TYPE.toLowerCase(), async (span) => {
      try {
        await this.client.send(
          new SendMessageCommand({
            QueueUrl: this.queueUrl,
            MessageBody: JSON.stringify(envelope),
            MessageAttributes: {
              type: { DataType: "String", StringValue: envelope.type },
              source: { DataType: "String", StringValue: envelope.source },
              // Inside the span, for the same reason as USER_CREATED above.
              ...traceparentAttributes(),
            },
          }),
        );

        // WARNING: Never log the code (the live credential this event delivers) nor
        // the plaintext email — event_id/user_id identify the message, email_hash the
        // recipient. See [[logging-context]]
        appLogger.info(
          {
            app_event: "password_reset_requested_published",
            event_type: envelope.type,
            event_id: envelope.event_id,
            user_id: payload.userId,
            email_hash: hashEmail(payload.email),
          },
          "PASSWORD_RESET_REQUESTED published",
        );
      } catch (err) {
        span.markFailed(err);

        // CONTRACT: Best-effort like USER_CREATED — the code row is already persisted,
        // and the endpoint answers identically either way (no enumeration), so
        // rethrowing reports a failure for a successful reset.
        // WARNING: Never log the code nor the plaintext email; only `email_hash` and
        // `user_id`. See [[logging-context]]
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
    });
  }
}
