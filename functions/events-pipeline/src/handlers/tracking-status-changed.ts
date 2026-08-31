import { z } from "zod";
import type { Envelope } from "#domain/envelope";
import { renderTemplate } from "#email/renderer";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";
import { publishToUser } from "#shared/realtime/websocket-publisher";
import type { HandlerDeps } from "#pipeline/process-record";

// CONTRACT: Payload fields are snake_case. Status is a forward-only progression.
// CONTRACT: Do NOT log payload or raw Zod errors (echoes recipient email). Report field paths only.
// See [[events-pipeline-design]]
// See [[logging-context]]
const TrackingStatusChangedPayloadSchema = z.object({
  status: z.enum(["PLACED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]),
  previous_status: z.string().min(1),
  changed_at: z.string().min(1),
  email: z.string().email(),
  full_name: z.string(),
  order_id: z.string().min(1),
  tracking_number: z.string().min(1),
  shipping_address: z.record(z.string(), z.unknown()).optional(),
  history: z.array(
    z.object({
      status: z.string().min(1),
      datetime: z.string().min(1),
    }),
  ),
});

// Maps payload.status to catalog key for variant rendering.
const TEMPLATE_BY_STATUS: Record<string, string> = {
  PLACED: "tracking-status-changed-placed",
  PROCESSING: "tracking-status-changed-processing",
  SHIPPED: "tracking-status-changed-shipped",
  OUT_FOR_DELIVERY: "tracking-status-changed-out-for-delivery",
  DELIVERED: "tracking-status-changed-delivered",
};

// Validates payload, renders template variant, sends email via SES, and publishes realtime event.
export async function trackingStatusChangedHandler(envelope: Envelope, deps: HandlerDeps = {}): Promise<void> {
  const result = TrackingStatusChangedPayloadSchema.safeParse(envelope.payload);

  if (!result.success) {
    // CONTRACT: Report field paths only on validation failure; raw Zod messages echo PII inputs.
    // See [[logging-context]]
    const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new PermanentError(`invalid TRACKING_STATUS_CHANGED payload: invalid fields: ${fields}`);
  }

  // Guard against missing status template mapping to ensure loud failure.
  const templateKey = TEMPLATE_BY_STATUS[result.data.status];
  if (!templateKey) {
    throw new PermanentError(`no template for status: ${result.data.status}`);
  }

  // Wire snake_case payload mapped to camelCase template props explicitly.
  const html = await renderTemplate(templateKey, {
    orderId: result.data.order_id,
    status: result.data.status,
    previousStatus: result.data.previous_status,
    changedAt: result.data.changed_at,
    fullName: result.data.full_name,
    trackingNumber: result.data.tracking_number,
    shippingAddress: result.data.shipping_address,
    history: result.data.history.map((entry) => ({
      status: entry.status,
      datetime: entry.datetime,
    })),
  });

  // sendEmail classifies SES outages as TransientError for automatic SQS retry.
  await sendEmail({
    to: result.data.email,
    subject: `Order ${envelope.order_id}: ${result.data.status.replace(/_/g, " ").toLowerCase()}`,
    html,
    // EmailType dimension uses variant template key to distinguish status variants.
    templateKey,
    // No `code`: this template carries none.
    recordEmail: deps.recordEmail,
  });

  // CONTRACT: Key realtime websocket publish by cognito_sub, not user_id. The connections GSI
  // is keyed by Cognito sub; user_id yields an empty list with no open connections found.
  // See [[user-id-vs-cognito-sub-ownership-key]]
  const cognitoSub = envelope.author.cognito_sub;
  if (cognitoSub) {
    await publishToUser(cognitoSub, {
      type: "TRACKING_STATUS_CHANGED",
      order_id: envelope.order_id,
      status: result.data.status,
      previous_status: result.data.previous_status,
      changed_at: result.data.changed_at,
    });
  }
}
