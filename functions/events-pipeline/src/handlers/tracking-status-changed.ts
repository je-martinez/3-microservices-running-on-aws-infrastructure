import { z } from "zod";
import type { Envelope } from "#domain/envelope";
import { renderTemplate } from "#email/renderer";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";

// Payload contract — snake_case, matching the envelope and the persisted
// event document (see the events-pipeline design spec's Data Model section
// and this service's CLAUDE.md §6): `status`, `previous_status`,
// `changed_at`, `email`. `status` is a forward-only progression per
// `docs/domains/tracking/specs/tracking-service-design.md`
// (PLACED -> PROCESSING -> SHIPPED -> OUT_FOR_DELIVERY -> DELIVERED); an
// unknown value is a PERMANENT error below, never transient — retrying can't
// make a status string valid. PLACED is the INITIAL status, emitted when
// Tracking creates the tracking, so its `previous_status` carries the
// "no previous status" marker rather than a real status.
//
// ANTICIPATED CONTRACT, not yet emitted by Tracking: as of this task,
// Tracking has no publisher at all for TRACKING_STATUS_CHANGED — Task 14
// wires one from `services/tracking/src/features/tracking/commands/
// update_status.py`. Two things that command's implementer must get right,
// verified by reading that file and its collaborators before writing this
// schema:
//
// 1. `user_id` (both the envelope's and, if echoed into the payload, this
//    payload's) MUST come from the PERSISTED `Tracking.user_id` column
//    (`services/tracking/src/features/tracking/domain/models.py`), never from
//    the request. The carrier webhook that drives this command is
//    authenticated by `TRACKING_CARRIER_API_KEY`, not a Cognito JWT — its
//    gateway route carries no `x-user-id` at all, and
//    `update_tracking_status` deliberately looks the tracking up unscoped
//    (`repository.get_by_order_id(command.order_id)`, no `user_id` filter —
//    see that function's docstring). An implementer who reaches for a
//    request-supplied user id has nothing to reach for and will ship an
//    event with no real owner.
// 2. Tracking does not currently resolve the user's EMAIL either — the same
//    gap Task 11 documented for Orders. Tracking already calls Users over
//    gRPC (`services/tracking/src/shared/grpc/users_client.py`,
//    `users.v1.Users/GetUserById`), but the client's own `ResolvedUser` value
//    object deliberately narrows the response to `internal_id` and
//    `cognito_sub` only — its docstring says so explicitly ("Deliberately
//    NOT carrying the address... Add it when something actually consumes
//    it"). `users.v1.UserResponse` already carries `email` on the wire (see
//    that same client module's "Never log a UserResponse" note), so Task 14
//    needs to: (a) add an `email` field to `ResolvedUser`
//    (`shared/grpc/users_client.py`), (b) thread it out of `resolve()`, and
//    (c) call `UsersGrpcClient.resolve` with the tracking's persisted
//    `user_id` from inside the publisher it adds alongside
//    `update_tracking_status`, mapping the result's snake_case-on-the-wire
//    proto field onto this schema's `email`. Until then this handler cannot
//    be exercised against Tracking's real output.
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
}
