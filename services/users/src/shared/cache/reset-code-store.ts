import type { RedisClient } from "./redis.ts";
import { hashEmail } from "#shared/logging/email-hash";
import { hashResetCode, resetCodeMatches, RESET_CODE_TTL_SECONDS } from "#shared/auth/reset-code";

// Key namespace. Everything this service puts in Redis is prefixed by what it
// is, so a shared instance stays legible and a targeted `SCAN`/flush is possible
// without guessing which keys belong to whom.
const KEY_PREFIX = "password-reset:";

// ==== THE KEY NEVER CONTAINS A PLAINTEXT EMAIL ====
// Redis keys are visible to anyone who can reach the instance — `KEYS *`, a
// `MONITOR` stream, a slowlog entry, a memory dump. Keying by the raw address
// would turn the store into a directory of "people who recently forgot their
// password", which is PII we deliberately keep out of logs (see [[logging-context]]),
// so keeping it out of Redis is the same rule applied one layer down.
//
// `hashEmail` is reused rather than a second hashing scheme invented here: it is
// already the service's stable, non-reversible email identifier, so the key
// matches the `email_hash` that appears in the log line for the same request —
// an operator debugging a reset can line the two up directly.
function keyFor(email: string): string {
  return `${KEY_PREFIX}${hashEmail(email)}`;
}

// The store behind the self-owned password-reset flow.
//
// WHY REDIS AND NOT A POSTGRES TABLE: a reset code is a ten-minute credential
// that must vanish on its own. Redis expires it NATIVELY with `EX`, so there is
// no `expires_at` column to compare against, no sweeper job to run, and no
// forgotten rows accumulating. A table would need all three, plus a migration,
// to model something that is by definition temporary.
//
// WHAT IS STORED: the SHA-256 of the code (`hashResetCode`), never the code
// itself. Anyone who can read this key must NOT be able to reset the account.
export class ResetCodeStore {
  private readonly redis: RedisClient;

  // Constructor-injected from the Awilix cradle (PROXY injection mode).
  constructor({ redis }: { redis: RedisClient }) {
    this.redis = redis;
  }

  // Stores the hash of `code` for `email`, replacing whatever was there.
  //
  // The overwrite IS the "invalidate the previous code" rule: one key per email
  // means a second request necessarily supersedes the first, so two codes can
  // never be live at once multiplying the guessing surface. In the table version
  // this took an explicit `updateMany({ consumedAt })`; here it is a property of
  // the key space, with no way to get it wrong.
  //
  // `EX` (not `PEXPIRE` afterwards) so the value and its lifetime are set in ONE
  // command: a crash between a SET and a separate expire call would leave a
  // never-expiring credential in Redis.
  async store(email: string, code: string): Promise<void> {
    await this.redis.set(keyFor(email), hashResetCode(code), "EX", RESET_CODE_TTL_SECONDS);
  }

  // Verifies `code` for `email` and, on success, DELETES the key.
  //
  // Single-use is enforced by that delete: a replay of the same code finds no
  // key and gets `false`. Expiry needs no check at all — Redis has already
  // removed the key, so an expired code is indistinguishable here from one that
  // never existed, which is exactly the answer the caller should give anyway
  // (both are `invalid_reset_code`, see the no-enumeration note in the command).
  //
  // Returns false — never throws — for "no code", "expired" and "wrong code"
  // alike. The command turns that single boolean into the single error the API
  // exposes, so there is no path by which one of the three could accidentally
  // become distinguishable to a caller.
  async verifyAndConsume(email: string, code: string): Promise<boolean> {
    const key = keyFor(email);
    const storedHash = await this.redis.get(key);
    if (storedHash === null) return false;

    // Constant-time compare (see `shared/auth/reset-code.ts`): a plain `===`
    // would leak, through timing, how many leading characters of the stored hash
    // matched.
    if (!resetCodeMatches(code, storedHash)) return false;

    // Consumed only on SUCCESS. A wrong guess deliberately does not delete the
    // key — otherwise anyone able to POST one wrong code could cancel a real
    // user's reset at will, a trivial denial of service. The code's own TTL
    // bounds the guessing window instead.
    await this.redis.del(key);
    return true;
  }
}
