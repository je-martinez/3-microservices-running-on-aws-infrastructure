import type { SQSClient, Message } from "@aws-sdk/client-sqs";
import { Consumer } from "sqs-consumer";
import { context, propagation, trace } from "@opentelemetry/api";
import { z } from "zod/v4";
import type { Env } from "#shared/config/env";
import { appLogger } from "#shared/logging/app-logger";
import { runWithLogContext } from "#shared/logging/log-context";
import type {
  CreateNotificationCommand,
  NotificationEnvelope,
} from "../commands/create-notification.ts";

// CONTRACT: The narrow slice of the envelope this consumer needs, and no more.
// Validating the whole wire contract here would reject a message the producers
// legitimately extend — the pipeline owns that schema, this one only needs enough
// to route and attribute the notification.
const EnvelopeSchema = z.object({
  type: z.string().min(1),
  user_id: z.string().min(1),
  order_id: z.string().nullable().default(null),
  author: z.object({
    actor: z.string().min(1),
    user_id: z.string().min(1).optional(),
    cognito_sub: z.string().min(1).optional(),
  }),
  payload: z.record(z.string(), z.unknown()),
});

/**
 * Consumes the notifications queue inside the Users process, sharing the Awilix
 * container, Prisma client and logger with the HTTP surface.
 *
 * CONTRACT: Constructed here but STARTED in server.ts, never in buildApp(). The
 * test suite calls buildApp too, and a live long-poll in every run would receive
 * and DELETE real messages outside any test's control — the same reason the metrics
 * poller is started there. See [[2026-09-10-in-app-notifications-design]]
 */
export class NotificationConsumer {
  private readonly consumer: Consumer;
  private readonly createNotificationCommand: CreateNotificationCommand;

  /** The trace id of the last handled message. Read by the trace-continuity test. */
  lastTraceId: string | undefined;

  constructor(deps: {
    sqsClient: SQSClient;
    env: Env;
    createNotificationCommand: CreateNotificationCommand;
  }) {
    this.createNotificationCommand = deps.createNotificationCommand;

    this.consumer = Consumer.create({
      queueUrl: deps.env.NOTIFICATIONS_QUEUE_URL,
      sqs: deps.sqsClient,
      // CONTRACT: `traceparent` must be requested explicitly — SQS omits message
      // attributes unless asked, and the trace would silently start fresh here.
      messageAttributeNames: ["All"],
      // Long-poll rather than spin: one request per 20s idle window instead of
      // one per iteration.
      waitTimeSeconds: 20,
      batchSize: 10,
      // CONTRACT: RETURN the message. sqs-consumer deletes only when the handler
      // returns one whose MessageId matches; a void return resolves to null and
      // the message is redelivered forever, draining nothing. Returning it after
      // `handleMessage` resolves keeps the delete strictly after the insert.
      handleMessage: async (message) => {
        await this.handleMessage(message);
        return message;
      },
    });

    // sqs-consumer emits rather than throws; without a listener an error here is
    // an unhandled 'error' event that takes the process down.
    this.consumer.on("error", (err) => {
      appLogger.error(
        { err, app_event: "notification_consumer_failed", reason: "sqs_error" },
        "notifications consumer error",
      );
    });
    this.consumer.on("processing_error", (err) => {
      appLogger.error(
        { err, app_event: "notification_consumer_failed", reason: "processing_error" },
        "notifications consumer failed to process a message",
      );
    });
  }

  start(): void {
    this.consumer.start();
    appLogger.info(
      { app_event: "notification_consumer_started" },
      "notifications consumer polling",
    );
  }

  stop(): void {
    this.consumer.stop();
    appLogger.info(
      { app_event: "notification_consumer_stopped" },
      "notifications consumer stopped",
    );
  }

  /**
   * Handles one message.
   *
   * CONTRACT: Throw ONLY on a transient failure. sqs-consumer deletes the message
   * when this resolves, which is the zero-cost mitigation the design calls for —
   * the insert commits before the delete, narrowing the duplicate window to a
   * crash between the two. A permanent error (unparseable body, invalid envelope)
   * is logged and RESOLVED, because retrying it to the DLQ cannot succeed.
   * See [[2026-09-10-in-app-notifications-design]]
   */
  async handleMessage(message: Message): Promise<void> {
    const parsed = this.parse(message);
    if (parsed === null) return;

    // Continue the producer's trace, as the pipeline does. With no traceparent
    // this yields the ambient (root) context, so the work is still traced.
    const carrier = this.carrier(message);
    const parentContext = propagation.extract(context.active(), carrier);
    this.lastTraceId = trace.getSpanContext(parentContext)?.traceId;

    return context.with(parentContext, () =>
      // The request_id seam every other flow in this service carries; there is no
      // HTTP request here, so the log context is seeded from the message instead.
      runWithLogContext(
        {
          user_id: parsed.user_id,
          ...(message.MessageId ? { request_id: message.MessageId } : {}),
        },
        async () => {
          await this.createNotificationCommand.execute(parsed);
        },
      ),
    );
  }

  /** The envelope, or null when the message can never be processed. */
  private parse(message: Message): NotificationEnvelope | null {
    if (!message.Body) {
      appLogger.error(
        {
          app_event: "notification_created_failed",
          reason: "empty_body",
          message_id: message.MessageId,
        },
        "notifications message carried no body",
      );
      return null;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(message.Body);
    } catch {
      // WARNING: Do NOT log the body — it carries the recipient's email.
      appLogger.error(
        {
          app_event: "notification_created_failed",
          reason: "body_not_json",
          message_id: message.MessageId,
        },
        "notifications message body is not JSON",
      );
      return null;
    }

    const result = EnvelopeSchema.safeParse(raw);
    if (!result.success) {
      // Field PATHS only: a raw Zod message echoes the rejected values, and those
      // include the email. See [[logging-context]]
      appLogger.error(
        {
          app_event: "notification_created_failed",
          reason: "invalid_envelope",
          fields: result.error.issues.map((issue) => issue.path.join(".")).join(", "),
          message_id: message.MessageId,
        },
        "notifications message failed envelope validation",
      );
      return null;
    }

    return result.data;
  }

  /** The W3C carrier from the message attributes, empty when none rode along. */
  private carrier(message: Message): Record<string, string> {
    const attributes = message.MessageAttributes ?? {};
    const carrier: Record<string, string> = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (value.StringValue) carrier[key] = value.StringValue;
    }
    return carrier;
  }
}
