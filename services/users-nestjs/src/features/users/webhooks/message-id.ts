import { createHash } from "node:crypto";

// CONTRACT: Do NOT simplify the encoding to a plain `${sub}:${triggerSource}`. A
// bare-`:` join is not injective — ("a:b","c") and ("a","b:c") both give "a:b:c" and
// hash identically, silently merging two different events into one idempotency key.
// Length-prefixing each component keeps the mapping provably injective whatever the
// inputs contain; this function must stay safe standalone, without relying on the
// Zod schema's uuid/enum constraints.
// See [[users-service-design]]
//
// The Cognito event carries no timestamp and no per-delivery unique field, so the key
// is derived and a retry hashes the same, swallowed by ON CONFLICT DO NOTHING. At
// PostConfirmation-only scope that means one row per (user, trigger type).
export function deriveMessageId(sub: string, triggerSource: string): string {
  const encoded = `${sub.length}:${sub}:${triggerSource.length}:${triggerSource}`;
  return createHash("sha256").update(encoded).digest("hex");
}
