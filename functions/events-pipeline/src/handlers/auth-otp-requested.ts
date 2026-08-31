import { z } from "zod";
import type { Envelope } from "#domain/envelope";
import { renderTemplate } from "#email/renderer";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";
import type { HandlerDeps } from "#pipeline/process-record";

// Payload contract — camelCase (`ttlSeconds`), like USER_CREATED and unlike the
// two snake_case payloads. `full_name` joins it in the producer's own snake_case
// spelling: that is literally what
// `infra/modules/cognito/otp-challenge-lambda/index.mjs` puts on the wire
// (`payload: { email, full_name: fullName, code, ttlSeconds }`), and this schema
// validates the wire, not a preference. Renaming it here would reject every OTP
// envelope.
//
// `full_name` is a plain `z.string()` — NOT `.min(1)`. Cognito has no `name`
// attribute populated today (Users' AdminCreateUser writes only `email`,
// `email_verified` and `custom:app_user_id`), so the producer falls back to `""`
// and the EMPTY STRING IS THE NORMAL PATH, not an edge case. A `.min(1)` here
// would reject the whole envelope and cost the user their login code over a
// missing greeting — the exact failure the producer's `?? ""` fallback exists to
// avoid.
const AuthOtpRequestedPayloadSchema = z.object({
  email: z.string().email(),
  full_name: z.string(),
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
export async function authOtpRequestedHandler(envelope: Envelope, deps: HandlerDeps = {}): Promise<void> {
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
  const html = await renderTemplate("auth-otp", {
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
    subject: "Your one-time code",
    html,
    templateKey: "auth-otp",

    // The store is the ONLY consumer of this field. The persisted event

    // document keeps its redaction (#domain/redact-payload) — this does not

    // relax it.

    code: result.data.code,

    recordEmail: deps.recordEmail,
  });
}
