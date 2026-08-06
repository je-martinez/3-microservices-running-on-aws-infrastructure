import { z } from "zod";
import type { Envelope } from "#domain/envelope";
import { renderTemplate } from "#email/renderer";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";

// Payload contract — camelCase, unlike ORDER_CREATED and
// TRACKING_STATUS_CHANGED. That is the producer's shape and it is deliberate:
// `fullName` has been on the wire since this handler existed, so the enrichment
// fields joined the payload's OWN convention rather than mixing `fullName` with
// `created_at` in one object. See the enrichment spec's "Payload changes"
// section. (The ENVELOPE around it is snake_case for every producer.)
//
// Verified against the producer, `services/users/src/shared/messaging/
// event-publisher.ts`, which emits exactly
// `{ email, fullName, userId, createdAt }` — `createdAt` already serialized to
// ISO-8601 by the publisher, hence a string here and not a coerced date.
//
// `userId` duplicates the envelope's root `user_id` on purpose: the renderer is
// handed the PAYLOAD, not the envelope, so a template that prints the account id
// has to read it from here. `createdAt` feeds the welcome email's "Member Since"
// row.
const UserCreatedPayloadSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
  userId: z.string().min(1),
  createdAt: z.string().min(1),
});

// The flow from the milestone design spec's "Email" section:
// validate payload (Zod) → render the react-email template to HTML →
// SES SendEmail → COMPLETED (the state machine records the status; this
// handler only has to return or throw).
export async function userCreatedHandler(envelope: Envelope): Promise<void> {
  const result = UserCreatedPayloadSchema.safeParse(envelope.payload);

  if (!result.success) {
    // PERMANENT: the payload will not become valid on a redelivery, so the
    // message is consumed and the document recorded FAILED.
    //
    // Only the FIELD PATHS are reported, never Zod's own message — it echoes
    // the offending input, which here is the user's plaintext email address.
    // This string is persisted on the event document and logged as `reason`
    // (see src/handler.ts), so it must be PII-free by construction.
    const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new PermanentError(`invalid USER_CREATED payload: invalid fields: ${fields}`);
  }

  const html = await renderTemplate("user-created", result.data);

  // sendEmail classifies its own failures as TransientError, so a SES outage
  // propagates as transient and the record is retried rather than consumed.
  await sendEmail({
    to: result.data.email,
    subject: "Welcome to 3MRAI",
    html,
  });
}
