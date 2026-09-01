import { z } from "zod";

// Deliberately NOT the production `events` collection. That one holds real
// records under a unique index on event_id and must never carry a TTL — a TTL
// on production data is a scheduled data-loss bug. This collection is test
// fixture data and is expected to disappear.
export const E2E_EMAILS_COLLECTION = "e2e_emails";

// One document per email the pipeline actually rendered and handed to SES.
//
// `code` is the plaintext OTP or reset code. It is redacted from the production
// event document on purpose (see #domain/redact-payload) and that redaction is
// NOT relaxed — this collection is written only when E2E_TESTING_ENABLED is on,
// holds only TTL-bounded rows, and must never be enabled in a deployed
// environment.
//
// Optional fields are OMITTED rather than null, matching the repo-wide logging
// contract: an absent field means "did not apply", and null would force every
// reader to handle a third state.
export const EmailRecordSchema = z.object({
  run_id: z.string().min(1),
  to: z.string().email(),
  subject: z.string().min(1),
  template_key: z.string().min(1),
  // Non-empty: an empty body would satisfy a truthiness check while proving
  // nothing about what was rendered.
  html: z.string().min(1),
  code: z.string().min(1).optional(),
  event_id: z.string().min(1),
  // Omitted when no span is active — the same rule logger.ts follows rather
  // than writing an all-zero id.
  trace_id: z.string().optional(),
  created_at: z.date(),
  expires_at: z.date(),
});

export type EmailRecord = z.infer<typeof EmailRecordSchema>;
