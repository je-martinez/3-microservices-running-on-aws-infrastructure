// Applied ONCE, at the exact point process-record.ts builds the document it
// persists to DocumentDB (doc.payload = ...), never to the envelope the handler
// receives later. Every other event type persists its payload verbatim (the
// audit trail, by design) — the two CREDENTIAL-BEARING types are the exception:
// a live, unexpired OTP or password-reset code sitting in the events collection
// would be a second, weaker copy of the authentication surface.
//
// PASSWORD_RESET_REQUESTED is if anything the stricter of the two: its code
// does not merely sign a user in, it authorises CHOOSING A NEW PASSWORD, so a
// leaked one hands over the account rather than one session.
//
// It does NOT belong in #shared/db/events-repository, which is deliberately
// type-agnostic: it writes whatever document it is handed, and pushing
// per-type knowledge down there would couple storage to the event taxonomy.
//
// A per-type map (rather than a blanket "strip any field named code") keeps
// this explicit and auditable: adding a new event type never accidentally
// redacts a legitimate field just because it happens to share a name.
const REDACTED_FIELDS: Record<string, readonly string[]> = {
  AUTH_OTP_REQUESTED: ["code"],
  PASSWORD_RESET_REQUESTED: ["code"],
};

// Pure: no I/O, no Mongo dependency, and it never mutates its input — the
// caller still holds the original payload and hands THAT to the handler.
export function redactPayload(
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const fields = Object.prototype.hasOwnProperty.call(REDACTED_FIELDS, type)
    ? REDACTED_FIELDS[type]
    : undefined;
  if (!fields || fields.length === 0) return payload;

  const redacted = { ...payload };
  for (const field of fields) {
    delete redacted[field];
  }
  return redacted;
}
