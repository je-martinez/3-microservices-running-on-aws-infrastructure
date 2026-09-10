// WARNING: The two credential-bearing types. A live OTP or password-reset code
// persisted in the events collection is a second, weaker copy of the
// authentication surface — and a reset code authorises choosing a NEW PASSWORD,
// handing over the account rather than one session.
// CONTRACT: Keep this a per-type map, not a blanket "strip any field named
// code", so a new event type never silently redacts a legitimate field. It stays
// out of #shared/db/events-repository, which is deliberately type-agnostic.
// See [[logging-context]]
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
