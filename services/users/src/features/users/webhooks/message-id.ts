import { createHash } from "node:crypto";

// Spec D4. The Cognito event carries no timestamp and no per-delivery unique
// field, so the key is derived from what the event *does* carry. A retry
// produces the same hash and is swallowed by ON CONFLICT DO NOTHING — exactly
// the duplicate we mean to prevent.
//
// Consequence (spec D5 warning): at PostConfirmation-only scope this stores one
// row per (user, trigger type). A recurring trigger would collide with itself.
//
// Encoding: each component is length-prefixed before concatenation
// (`${sub.length}:${sub}:${triggerSource.length}:${triggerSource}`) rather than
// naively joined with a bare `:`. A bare-`:` join is NOT injective — e.g.
// ("a:b", "c") and ("a", "b:c") both concatenate to "a:b:c" and would hash
// identically, silently merging two different events into one idempotency key.
// Length-prefixing each component makes the boundary between sub and
// triggerSource unambiguous regardless of what characters either contains, so
// the mapping from (sub, triggerSource) to the encoded string is provably
// injective. Do NOT simplify this back to a plain `${sub}:${triggerSource}`
// concatenation — it currently happens to be safe only because the Zod schema
// constrains sub to a uuid and triggerSource to a closed enum (neither can
// contain ':'), but this function has no such guard of its own and must stay
// safe standalone.
export function deriveMessageId(sub: string, triggerSource: string): string {
  const encoded = `${sub.length}:${sub}:${triggerSource.length}:${triggerSource}`;
  return createHash("sha256").update(encoded).digest("hex");
}
