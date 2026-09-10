import { z } from "zod";

// CONTRACT: `author` is WHO ORIGINATED the event; the envelope's root `user_id`
// is its SUBJECT. They differ routinely — a carrier-webhook
// TRACKING_STATUS_CHANGED is about a user but originated from no human — and
// collapsing them leaves `created_by` naming only what wrote the row.
// `actor` is the producer's own AuditActor, `<source>:<action>`.
// See [[audit-fields]]

// CONTRACT: Do NOT send `user_id`/`cognito_sub` as null or as the actor label
// when no human acted — OMIT them. And do NOT add `author.source`: the producing
// service is already the envelope's root `source`, and two copies drift.
// See [[logging-context]]
export const AuthorSchema = z.object({
  actor: z.string().min(1),
  user_id: z.string().min(1).optional(),
  cognito_sub: z.string().min(1).optional(),
});

export type Author = z.infer<typeof AuthorSchema>;

// The producer→pipeline contract. `type` and `source` are also SQS message
// attributes, so the queue is inspectable without deserializing the body.
// CONTRACT: Keep `author` REQUIRED. Optional silently admits unattributed
// events, and the loss only surfaces as a generic `created_by` long after.
export const EnvelopeSchema = z.object({
  event_id: z.string().min(1),
  type: z.string().min(1),
  source: z.string().min(1),
  user_id: z.string().min(1),
  order_id: z.string().min(1).nullable(),
  author: AuthorSchema,
  // Cross-service correlation id (`req_` + nanoid), minted at the producer's
  // HTTP ingress. This Lambda is a CONSUMER: it never mints one.
  // CONTRACT: Do NOT make this required. Messages published before the field
  // existed can still be on the queue at deploy time, and a schema failure here
  // is a PermanentError — the record is not retried and its email is LOST.
  // `.min(1)`: an explicit "" is a producer bug, and accepting it stamps a blank
  // correlation id across a whole record's log lines instead of omitting it.
  // See [[logging-context]]
  request_id: z.string().min(1).optional(),
  // E2E ONLY. Scopes the e2e_emails fixture collection per Playwright run, which
  // workers and reruns share.
  // CONTRACT: Do NOT make this required, for the same reason as `request_id`
  // above — an in-flight message without it becomes a PermanentError and loses
  // its email. `.min(1)`: "" would attribute a fixture row to a nonexistent run.
  run_id: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;
