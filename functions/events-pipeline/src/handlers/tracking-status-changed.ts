import { z } from "zod";
import type { Envelope } from "#domain/envelope";
import { renderTemplate } from "#email/renderer";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";
import { publishToUser } from "#shared/realtime/websocket-publisher";

// Payload contract — snake_case, matching the envelope and the persisted
// event document (see the events-pipeline design spec's Data Model section
// and this service's CLAUDE.md §6): `status`, `previous_status`,
// `changed_at`, `email`. `status` is a forward-only progression per
// `docs/domains/tracking/specs/tracking-service-design.md`
// (PLACED -> PROCESSING -> SHIPPED -> OUT_FOR_DELIVERY -> DELIVERED); an
// unknown value is a PERMANENT error below, never transient — retrying can't
// make a status string valid.
//
// `PLACED` is in the enum because it is a valid STATUS, not because this
// handler ever receives it in practice: it is the status a tracking is CREATED
// in, and `create_tracking.py` publishes nothing (verified — it holds no
// publisher call at all). Emission happens only in `update_status.py`, the
// transition path, which creation never takes. So a TestMode run writes five
// history rows and sends FOUR events. Anything asserting one message per status
// waits forever for a fifth that is never sent.
const TrackingStatusChangedPayloadSchema = z.object({
  status: z.enum(["PLACED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]),
  previous_status: z.string().min(1),
  changed_at: z.string().min(1),
  email: z.string().email(),
});

// Maps payload.status -> the catalog key for that variant. All five keys
// back the SAME tracking-status-changed.tsx component (see the milestone
// design spec: "one event type, five rendered variants" — the fan-out is
// here, inside the handler, not in the dispatch map in #handlers/index).
const TEMPLATE_BY_STATUS: Record<string, string> = {
  PLACED: "tracking-status-changed-placed",
  PROCESSING: "tracking-status-changed-processing",
  SHIPPED: "tracking-status-changed-shipped",
  OUT_FOR_DELIVERY: "tracking-status-changed-out-for-delivery",
  DELIVERED: "tracking-status-changed-delivered",
};

// The flow from the milestone design spec's "Email" section, mirroring
// #handlers/order-created: validate payload (Zod) -> pick the template
// variant from payload.status -> render the react-email template to HTML ->
// SES SendEmail -> COMPLETED (the state machine records the status; this
// handler only has to return or throw).
export async function trackingStatusChangedHandler(envelope: Envelope): Promise<void> {
  const result = TrackingStatusChangedPayloadSchema.safeParse(envelope.payload);

  if (!result.success) {
    // PERMANENT: the payload will not become valid on a redelivery, so the
    // message is consumed and the document recorded FAILED.
    //
    // Only the FIELD PATHS are reported, never Zod's own message — it echoes
    // the offending input, which here can be the recipient's plaintext email
    // address. This string is persisted on the event document and logged as
    // `reason` (see src/handler.ts), so it must be PII-free by construction.
    const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new PermanentError(`invalid TRACKING_STATUS_CHANGED payload: invalid fields: ${fields}`);
  }

  // Zod's enum already rejects anything outside the five known statuses, so
  // this lookup can never miss in practice. The explicit guard below keeps a
  // future change to the enum (or a refactor that loosens it) from silently
  // sending `undefined` into renderTemplate instead of failing loudly.
  const templateKey = TEMPLATE_BY_STATUS[result.data.status];
  if (!templateKey) {
    throw new PermanentError(`no template for status: ${result.data.status}`);
  }

  const html = await renderTemplate(templateKey, {
    orderId: envelope.order_id,
    status: result.data.status,
    previousStatus: result.data.previous_status,
  });

  // sendEmail classifies its own failures as TransientError, so a SES outage
  // propagates as transient and the record is retried rather than consumed.
  await sendEmail({
    to: result.data.email,
    subject: `Order ${envelope.order_id}: ${result.data.status.replace(/_/g, " ").toLowerCase()}`,
    html,
  });

  // Realtime fan-out, AFTER the email. Secondary to it in every sense: the
  // email is the durable notification, this is opportunistic, and
  // `publishToUser` never throws — a push failure must not fail the event and
  // trigger an SQS retry that would send a duplicate email.
  //
  // Keyed by `author.cognito_sub`, NOT `envelope.user_id`. The latter is the
  // internal usr_ id; the connections GSI is keyed by the Cognito sub, so
  // querying with user_id returns an empty list indistinguishable from "no open
  // connections". See the user-id-vs-cognito-sub-ownership-key ADR.
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
