import { describe, it, expect, vi, beforeEach } from "vitest";
import { ResetCodeStore } from "#shared/cache/reset-code-store";
import { hashResetCode, RESET_CODE_TTL_SECONDS } from "#shared/auth/reset-code";
import { hashEmail } from "#shared/logging/email-hash";

const EMAIL = "jose@example.com";
const CODE = "123456";

// A minimal in-memory stand-in for the two ioredis commands the store uses.
// Deliberately NOT a blanket `vi.fn()` mock of the whole client: the tests below
// assert on the exact arguments passed to `set` (the `EX` form), which is the
// part a mocked-away client would let silently regress — see [[mocks-hide-schema-bugs]].
function fakeRedis() {
  const data = new Map<string, string>();
  return {
    data,
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _mode: string, _ttl: number) => {
      data.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => (data.delete(key) ? 1 : 0)),
  };
}

let redis: ReturnType<typeof fakeRedis>;
let store: ResetCodeStore;

beforeEach(() => {
  redis = fakeRedis();
  store = new ResetCodeStore({ redis: redis as never });
});

describe("ResetCodeStore.store", () => {
  it("keys by the email HASH, never the plaintext email", async () => {
    await store.store(EMAIL, CODE);

    const [key] = redis.set.mock.calls[0]!;
    expect(key).toBe(`password-reset:${hashEmail(EMAIL)}`);
    // The load-bearing assertion: a Redis key is readable by anyone with access
    // to the instance, so the address must not appear in it in any form.
    expect(key).not.toContain(EMAIL);
    expect(key).not.toContain("jose");
  });

  it("stores the code HASH, never the plaintext code", async () => {
    await store.store(EMAIL, CODE);

    const [, value] = redis.set.mock.calls[0]!;
    expect(value).toBe(hashResetCode(CODE));
    expect(value).not.toContain(CODE);
  });

  it("sets the native TTL in the same command as the value", async () => {
    await store.store(EMAIL, CODE);

    // `EX 600` on the SET itself — not a follow-up PEXPIRE, which could be
    // skipped by a crash and leave a never-expiring credential.
    expect(redis.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "EX",
      RESET_CODE_TTL_SECONDS,
    );
    expect(RESET_CODE_TTL_SECONDS).toBe(600);
  });

  it("supersedes a previous code for the same email (one key per email)", async () => {
    await store.store(EMAIL, "111111");
    await store.store(EMAIL, "222222");

    expect(redis.data.size).toBe(1);
    // The older code must no longer verify: two live codes would double the
    // guessing surface for no benefit.
    expect(await store.verifyAndConsume(EMAIL, "111111")).toBe(false);
  });
});

describe("ResetCodeStore.verifyAndConsume", () => {
  it("accepts the stored code", async () => {
    await store.store(EMAIL, CODE);
    expect(await store.verifyAndConsume(EMAIL, CODE)).toBe(true);
  });

  it("is single-use: a replay of an accepted code is rejected", async () => {
    await store.store(EMAIL, CODE);

    expect(await store.verifyAndConsume(EMAIL, CODE)).toBe(true);
    expect(redis.del).toHaveBeenCalledWith(`password-reset:${hashEmail(EMAIL)}`);
    // The whole point of the delete: the same code cannot be used twice.
    expect(await store.verifyAndConsume(EMAIL, CODE)).toBe(false);
  });

  it("rejects a wrong code", async () => {
    await store.store(EMAIL, CODE);
    expect(await store.verifyAndConsume(EMAIL, "999999")).toBe(false);
  });

  it("does NOT consume the code on a wrong guess", async () => {
    await store.store(EMAIL, CODE);

    await store.verifyAndConsume(EMAIL, "999999");
    expect(redis.del).not.toHaveBeenCalled();
    // Otherwise anyone could cancel a real user's reset by posting one wrong
    // code — a trivial denial of service.
    expect(await store.verifyAndConsume(EMAIL, CODE)).toBe(true);
  });

  it("rejects when no code is stored (expired or never requested)", async () => {
    // Redis removes the key itself at TTL, so an expired code is exactly this
    // case — there is no expiry branch in the store to test separately.
    expect(await store.verifyAndConsume(EMAIL, CODE)).toBe(false);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("does not accept a code stored for a different email", async () => {
    await store.store(EMAIL, CODE);
    expect(await store.verifyAndConsume("someone-else@example.com", CODE)).toBe(false);
  });
});
