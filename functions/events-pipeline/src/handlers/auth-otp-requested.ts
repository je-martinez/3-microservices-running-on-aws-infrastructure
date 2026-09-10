import { z } from "zod";
import type { Envelope } from "#domain/envelope";
import { renderTemplate } from "#email/renderer";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";
import type { HandlerDeps } from "#pipeline/process-record";

// CONTRACT: This schema validates the WIRE. `full_name` is the producer's
// snake_case spelling next to camelCase `ttlSeconds`; renaming it here rejects
// every OTP envelope. And `full_name` is a plain `z.string()`, NOT `.min(1)` —
// Cognito populates no `name` attribute, so the producer sends "" and the EMPTY
// STRING IS THE NORMAL PATH. A `.min(1)` costs the user their login code over a
// missing greeting.
const AuthOtpRequestedPayloadSchema = z.object({
  email: z.string().email(),
  full_name: z.string(),
  code: z.string().min(1),
  ttlSeconds: z.number().positive(),
});

// validate (Zod) → render → SES SendEmail.
// CONTRACT: The in-memory payload holds the real code, because emailing it is
// the point. It is the PERSISTED copy that never carries it — #domain/redact-
// payload strips it in #pipeline/process-record.
export async function authOtpRequestedHandler(envelope: Envelope, deps: HandlerDeps = {}): Promise<void> {
  const result = AuthOtpRequestedPayloadSchema.safeParse(envelope.payload);

  if (!result.success) {
    // PERMANENT: a redelivery cannot make this payload valid.
    // CONTRACT: Report FIELD PATHS only, never Zod's message — it echoes the
    // offending input, here a LIVE OTP code alongside the plaintext email. This
    // string is persisted and logged as `reason`.
    // See [[logging-context]]
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
