import { z } from "zod";
import type { Envelope } from "#domain/envelope";
import { renderTemplate } from "#email/renderer";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";
import type { HandlerDeps } from "#pipeline/process-record";

// CONTRACT: Identical by design to AUTH_OTP_REQUESTED's schema, mixed casing
// included — this validates the WIRE, and the two events carry the same four
// facts. `full_name` is a plain `z.string()`, NOT `.min(1)`: Cognito populates
// no `name` attribute, so "" is the normal path and `.min(1)` costs the user
// their reset code. `code` stays `.min(1)` rather than a six-digit pattern — a
// length rule turns a Cognito format change into silently discarded emails.
const PasswordResetRequestedPayloadSchema = z.object({
  email: z.string().email(),
  full_name: z.string(),
  code: z.string().min(1),
  ttlSeconds: z.number().positive(),
});

// validate (Zod) → render → SES SendEmail.
// CONTRACT: The in-memory payload holds the real code, because emailing it is
// the point. It is the PERSISTED copy that never carries it — #domain/redact-
// payload strips it in #pipeline/process-record.
export async function passwordResetRequestedHandler(envelope: Envelope, deps: HandlerDeps = {}): Promise<void> {
  const result = PasswordResetRequestedPayloadSchema.safeParse(envelope.payload);

  if (!result.success) {
    // PERMANENT: a redelivery cannot make this payload valid.
    // CONTRACT: Report FIELD PATHS only, never Zod's message — it echoes the
    // offending input, here a LIVE reset code alongside the plaintext email.
    // This string is persisted and logged as `reason`.
    // See [[logging-context]]
    const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new PermanentError(`invalid PASSWORD_RESET_REQUESTED payload: invalid fields: ${fields}`);
  }

  const ttlMinutes = Math.round(result.data.ttlSeconds / 60);
  const html = await renderTemplate("forgot-password", {
    code: result.data.code,
    ttlMinutes,
    // Possibly `""` — see the schema comment. The template must degrade to a
    // nameless greeting rather than printing an empty gap, so the prop is
    // always PRESENT and the template decides what to do with an empty value.
    fullName: result.data.full_name,
  });

  // sendEmail classifies its own failures as TransientError, so a SES outage
  // propagates as transient and the record is retried rather than consumed.
  await sendEmail({
    to: result.data.email,
    subject: "Reset your password",
    html,
    templateKey: "forgot-password",

    // The store is the ONLY consumer of this field. The persisted event

    // document keeps its redaction (#domain/redact-payload) — this does not

    // relax it.

    code: result.data.code,

    recordEmail: deps.recordEmail,
  });
}
