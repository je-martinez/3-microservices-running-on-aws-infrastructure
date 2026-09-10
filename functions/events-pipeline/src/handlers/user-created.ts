import { z } from "zod";
import type { Envelope } from "#domain/envelope";
import { renderTemplate } from "#email/renderer";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";
import type { HandlerDeps } from "#pipeline/process-record";

// CONTRACT: This payload is camelCase — the producer's own shape — while the
// ENVELOPE around it is snake_case. This schema validates the wire, not a
// preference. `createdAt` arrives already ISO-8601, hence a string rather than a
// coerced date. `userId` duplicates the envelope's root `user_id` on purpose:
// the renderer is handed the PAYLOAD, so a template reads the account id here.
const UserCreatedPayloadSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
  userId: z.string().min(1),
  createdAt: z.string().min(1),
});

// validate (Zod) → render the react-email template → SES SendEmail. The state
// machine records the status; this handler returns or throws.
export async function userCreatedHandler(envelope: Envelope, deps: HandlerDeps = {}): Promise<void> {
  const result = UserCreatedPayloadSchema.safeParse(envelope.payload);

  if (!result.success) {
    // PERMANENT: a redelivery cannot make this payload valid.
    // CONTRACT: Report FIELD PATHS only, never Zod's message — it echoes the
    // offending input, here the user's plaintext email. This string is persisted
    // and logged as `reason`, so it must be PII-free by construction.
    // See [[logging-context]]
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
    templateKey: "user-created",
    // No `code`: this template carries none.
    recordEmail: deps.recordEmail,
  });
}
