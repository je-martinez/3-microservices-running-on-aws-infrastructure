import { describe, it, expect } from "vitest";
import { meCacheKey, ME_KEY_PREFIX } from "#shared/cache/cache-keys";

describe("meCacheKey", () => {
  it("builds users:me:v1:{cognito_sub}:{user_id}", () => {
    expect(meCacheKey("sub-abc", "usr_1")).toBe("users:me:v1:sub-abc:usr_1");
  });

  // Cross-user isolation starts HERE, at the key. Two callers must never
  // produce the same key, and this is the cheapest place to prove it.
  it("produces a different key per user", () => {
    expect(meCacheKey("sub-a", "usr_a")).not.toBe(meCacheKey("sub-b", "usr_b"));
    // Same sub, different resolved user (a re-provisioned account) is also a
    // different key: BOTH components are part of the identity.
    expect(meCacheKey("sub-a", "usr_a")).not.toBe(meCacheKey("sub-a", "usr_b"));
  });

  // The prefix is the ONLY form that may appear in a CloudWatch dimension or a
  // span attribute — the full key embeds cognito_sub and user_id.
  it("exposes a prefix carrying no identity", () => {
    expect(ME_KEY_PREFIX).toBe("users:me:v1");
    expect(meCacheKey("sub-abc", "usr_1").startsWith(`${ME_KEY_PREFIX}:`)).toBe(true);
  });
});
