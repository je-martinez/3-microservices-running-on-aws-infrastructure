import { z } from "zod";

// WHO ORIGINATED the event — distinct from the envelope's root `user_id`, which
// is the event's SUBJECT (the user the event is ABOUT).
//
// The two are not the same and routinely differ: TRACKING_STATUS_CHANGED fired
// by the carrier webhook is about a user (`user_id`) but originated from no
// human at all. Without this object those two cases are indistinguishable, and
// the persisted `created_by` could only say "events-pipeline" — i.e. "the thing
// that wrote the row", never "the thing that caused it".
//
// `actor` is the producer's semantic AuditActor, format `<source>:<action>` —
// the SAME value that service already stamps into its own `created_by` columns
// (Users' enum, Orders' static class, Tracking's StrEnum). It was simply lost at
// publish time; this field transports it.
//
// `user_id`/`cognito_sub` are the REAL ids of a human actor, when there is one.
// They are OPTIONAL and must be OMITTED — never null, never filled with the
// actor label — when no human acted, per the "unknown fields are omitted, never
// null" rule in docs/shared/conventions/logging-context.md.
//
// There is deliberately NO `author.source`: the producing service is already the
// envelope's root `source` (a per-publisher constant: "users"/"orders"/
// "tracking"), and duplicating it inside `author` would carry no information
// while inviting the two copies to disagree. The actor label's own leading
// segment (`users_api`, `tracking_api`, …) names the API surface, which is a
// different axis again.
export const AuthorSchema = z.object({
  actor: z.string().min(1),
  user_id: z.string().min(1).optional(),
  cognito_sub: z.string().min(1).optional(),
});

export type Author = z.infer<typeof AuthorSchema>;

// The producer→pipeline contract. `type` and `source` are ALSO set as SQS
// message attributes (see the producers in Block D), so the queue can be
// inspected without deserializing the body — this schema validates the body.
//
// `author` is REQUIRED, not optional: all three producers set it in the same
// change, and an optional field would silently permit an unattributed event —
// forever, and undetectably, since the missing attribution only shows up as a
// generic `created_by` long after the fact.
export const EnvelopeSchema = z.object({
  event_id: z.string().min(1),
  type: z.string().min(1),
  source: z.string().min(1),
  user_id: z.string().min(1),
  order_id: z.string().min(1).nullable(),
  author: AuthorSchema,
  // Cross-service correlation id (`req_` + nanoid), minted at the producing
  // service's HTTP ingress and carried here on the envelope. This Lambda is a
  // CONSUMER: it never generates one, it only reads what the producer sent.
  // It matters more here than anywhere else — this function runs no OTel SDK
  // (JE-138), so `trace_id` is absent and `request_id` is the ONLY thing tying
  // its work back to the request that caused it.
  //
  // OPTIONAL, AND IT MUST STAY OPTIONAL. Do not "tidy" this into a required
  // field. At deploy time there can be messages already sitting on the queue
  // that were published before this field existed. A required field would fail
  // EnvelopeSchema for those in-flight messages, and per this pipeline's error
  // handling a schema failure is a PermanentError: the record is NOT retried,
  // and the notification email it was meant to send is LOST. Optional costs
  // nothing for new messages and loses nothing for old ones.
  //
  // `.min(1)` like its siblings: an explicit `""` is a producer bug, and
  // accepting it would put a blank correlation id on a whole record's worth of
  // log lines rather than honestly omitting the field.
  request_id: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;
