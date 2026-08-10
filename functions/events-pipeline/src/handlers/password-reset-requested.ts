import { z } from "zod";
import type { Envelope } from "#domain/envelope";
import { renderTemplate } from "#email/renderer";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";

// Payload contract — DELIBERATELY IDENTICAL to AUTH_OTP_REQUESTED's
// (`{ email, full_name, code, ttlSeconds }`), including its mixed casing:
// `full_name` in the producer's snake_case next to camelCase `ttlSeconds`. The
// two events carry the same four facts, so a second spelling of the same shape
// would be a difference with no meaning behind it — and this schema validates
// the wire, not a preference.
//
// `full_name` is a plain `z.string()` — NOT `.min(1)`. Cognito has no `name`
// attribute populated today (Users' AdminCreateUser writes only `email`,
// `email_verified` and `custom:app_user_id`), so the producer falls back to `""`
// and the EMPTY STRING IS THE NORMAL PATH, not an edge case. A `.min(1)` here
// would reject the whole envelope and cost the user their reset code over a
// missing greeting.
//
// `code` is Cognito's six-digit ForgotPassword code, kept as `z.string().min(1)`
// rather than a six-digit pattern: a length rule here would turn a Cognito
// format change into silently discarded reset emails, and the template already
// renders codes of any length one box per character.
const PasswordResetRequestedPayloadSchema = z.object({
  email: z.string().email(),
  full_name: z.string(),
  code: z.string().min(1),
  ttlSeconds: z.number().positive(),
});

// Same flow as authOtpRequestedHandler: validate payload (Zod) → render the
// react-email template to HTML → SES SendEmail → COMPLETED.
//
// The code reaches this handler through the envelope's payload, exactly as
// every other event type does. It is the PERSISTED copy of that payload that
// never carries it (see #domain/redact-payload, applied in
// #pipeline/process-record) — not this in-memory one, which has to hold the
// real code in order to email it.
export async function passwordResetRequestedHandler(envelope: Envelope): Promise<void> {
  const result = PasswordResetRequestedPayloadSchema.safeParse(envelope.payload);

  if (!result.success) {
    // PERMANENT: the payload will not become valid on a redelivery, so the
    // message is consumed and the document recorded FAILED.
    //
    // Only the FIELD PATHS are reported, never Zod's own message — it echoes
    // the offending input, which here would be the reset code itself, a live
    // credential, on top of the plaintext email address. This string is
    // persisted on the (already-redacted) event document and logged as
    // `reason` (see src/handler.ts), so it must be credential- and PII-free by
    // construction.
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
  });
}
