import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { env } from "#shared/config/env";
import { appLogger } from "#shared/logging/app-logger";

/**
 * Writes a message this consumer refuses to process to the dead-letter queue,
 * before the handler ACKs it.
 *
 * CONTRACT: NOT the redrive path. Redrive moves a message SQS gave up RETRYING;
 * one rejected as permanently invalid is excluded from `batchItemFailures`, so
 * SQS deletes it and redrive never sees it. See [[events-pipeline-design]]
 *
 * CONTRACT: Quarantine NEVER fails the record — a DLQ that is down must not turn
 * a message we decided to drop into a retry. Failures are swallowed and logged.
 * CONTRACT: `EVENTS_DLQ_URL` is optional — absence degrades to no copy.
 */

/**
 * WHY: Module scope, so the connection is reused across invocations of a warm
 * Lambda. `AWS_ENDPOINT_URL` is what points it at Floci locally; unset, the SDK
 * resolves the real endpoint from the region.
 */
const client = new SQSClient({
  region: env.AWS_REGION,
  ...(env.AWS_ENDPOINT_URL === undefined ? {} : { endpoint: env.AWS_ENDPOINT_URL }),
});

/** Why a message was refused. Rides as an attribute so the DLQ is triageable. */
export type QuarantineReason = "invalid_envelope" | "persist_failed" | "unknown_event_type";

export interface QuarantineInput {
  /** The RAW body, byte for byte — the point is to preserve what actually arrived. */
  readonly body: string;
  readonly messageId: string;
  readonly reason: QuarantineReason;
}

/**
 * Copies one rejected message to the DLQ. Resolves either way.
 *
 * @returns whether the copy landed — for the caller's log line, never for control flow.
 */
export async function quarantine({ body, messageId, reason }: QuarantineInput): Promise<boolean> {
  if (env.EVENTS_DLQ_URL === undefined) {
    // Not an error: an environment without the variable is explicitly opting out
    // of the copy, and the ACK below is still correct.
    appLogger.warn(
      {
        app_event: "quarantine_skipped",
        reason: "dlq_not_configured",
        quarantine_reason: reason,
        message_id: messageId,
      },
      "no EVENTS_DLQ_URL: the rejected message is dropped without a copy",
    );
    return false;
  }

  try {
    await client.send(
      new SendMessageCommand({
        QueueUrl: env.EVENTS_DLQ_URL,
        // CONTRACT: The ORIGINAL body, unwrapped and unmodified. An operator
        // redriving this message needs exactly what the producer sent; a body
        // re-serialized into a envelope-of-our-own would not survive a redrive
        // back onto the main queue, because the consumer would then reject the
        // wrapper too.
        MessageBody: body,
        // WHY: The reason travels as an ATTRIBUTE rather than in the body, for
        // the same reason — attributes are droppable metadata, the body is the
        // contract. `aws sqs receive-message --message-attribute-names All`
        // shows them without deserializing anything.
        MessageAttributes: {
          quarantine_reason: { DataType: "String", StringValue: reason },
          original_message_id: { DataType: "String", StringValue: messageId },
        },
      }),
    );

    appLogger.warn(
      {
        app_event: "event_quarantined",
        quarantine_reason: reason,
        message_id: messageId,
      },
      "copied a rejected message to the dead-letter queue",
    );
    return true;
  } catch (err) {
    // CONTRACT: Swallowed, never rethrown — see this module's header. Log the
    // error CLASS only: an SQS error's message can echo the body we are
    // deliberately not logging (PII). See [[logging-context]]
    appLogger.error(
      {
        app_event: "quarantine_failed",
        reason: err instanceof Error ? err.name : "send_failed",
        quarantine_reason: reason,
        message_id: messageId,
      },
      "could not copy a rejected message to the dead-letter queue",
    );
    return false;
  }
}
