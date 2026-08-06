import { z } from "zod";
import type { Envelope } from "#domain/envelope";
import { renderTemplate } from "#email/renderer";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";

const AuthOtpRequestedPayloadSchema = z.object({
  email: z.string().email(),
  code: z.string().min(1),
  ttlSeconds: z.number().positive(),
});

// Same flow as userCreatedHandler: validate payload (Zod) → render the
// react-email template to HTML → SES SendEmail → COMPLETED.
//
// The code reaches this handler through the envelope's payload, exactly as
// every other event type does. It is the PERSISTED copy of that payload that
// never carries it (see #domain/redact-payload, applied in
// #pipeline/process-record) — not this in-memory one, which has to hold the
// real code in order to email it.
export async function authOtpRequestedHandler(envelope: Envelope): Promise<void> {
  const result = AuthOtpRequestedPayloadSchema.safeParse(envelope.payload);

  if (!result.success) {
    // PERMANENT: the payload will not become valid on a redelivery, so the
    // message is consumed and the document recorded FAILED.
    //
    // Only the FIELD PATHS are reported, never Zod's own message — it echoes
    // the offending input, which here would be the OTP code itself, a live
    // credential, on top of the plaintext email address. This string is
    // persisted on the (already-redacted) event document and logged as
    // `reason` (see src/handler.ts), so it must be credential- and PII-free by
    // construction.
    const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new PermanentError(`invalid AUTH_OTP_REQUESTED payload: invalid fields: ${fields}`);
  }

  const ttlMinutes = Math.round(result.data.ttlSeconds / 60);
  const html = await renderTemplate("auth-otp", { code: result.data.code, ttlMinutes });

  // sendEmail classifies its own failures as TransientError, so a SES outage
  // propagates as transient and the record is retried rather than consumed.
  await sendEmail({
    to: result.data.email,
    subject: "Your one-time code",
    html,
  });
}
