import type { RedisClient } from "./redis.ts";
import { hashEmail } from "#shared/logging/email-hash";
import { hashResetCode, resetCodeMatches, RESET_CODE_TTL_SECONDS } from "#shared/auth/reset-code";

// Key namespace: everything this service puts in Redis is prefixed by what it is,
// so a shared instance stays legible and a targeted SCAN/flush is possible.
const KEY_PREFIX = "password-reset:";

// CONTRACT: The key NEVER contains a plaintext email. Redis keys are visible via
// `KEYS *`, MONITOR, the slowlog and memory dumps, so a raw address turns this store
// into a directory of "people who recently forgot their password". Reuse `hashEmail`
// rather than inventing a second scheme, so the key matches the `email_hash` on the
// same request's log line. See [[logging-context]]
function keyFor(email: string): string {
  return `${KEY_PREFIX}${hashEmail(email)}`;
}

// CONTRACT: Store the SHA-256 of the code (`hashResetCode`), never the code — anyone
// who can read this key must NOT be able to reset the account.
// WHY: Redis rather than a Postgres table — a ten-minute credential expires natively
// with `EX`, so there is no `expires_at` column, no sweeper job and no stale rows.
export class ResetCodeStore {
  private readonly redis: RedisClient;

  // Constructor-injected from the Awilix cradle (PROXY injection mode).
  constructor({ redis }: { redis: RedisClient }) {
    this.redis = redis;
  }

  // CONTRACT: Set the value and its TTL in ONE command with `EX`, never a SET
  // followed by PEXPIRE — a crash between the two leaves a never-expiring credential
  // in Redis. The overwrite is what invalidates the previous code: one key per email
  // means two codes can never be live at once.
  async store(email: string, code: string): Promise<void> {
    await this.redis.set(keyFor(email), hashResetCode(code), "EX", RESET_CODE_TTL_SECONDS);
  }

  // CONTRACT: Return false — never throw — for "no code", "expired" and "wrong code"
  // alike, so no caller can tell the three apart. The delete on success is what makes
  // a code single-use: a replay finds no key. Expiry needs no check, Redis has
  // already removed it.
  async verifyAndConsume(email: string, code: string): Promise<boolean> {
    const key = keyFor(email);
    const storedHash = await this.redis.get(key);
    if (storedHash === null) return false;

    // CONTRACT: Constant-time compare — a plain `===` leaks, through timing, how many
    // leading characters of the stored hash matched.
    if (!resetCodeMatches(code, storedHash)) return false;

    // CONTRACT: Consume only on SUCCESS. Deleting on a wrong guess lets anyone who
    // can POST one bad code cancel a real user's reset at will; the TTL bounds the
    // guessing window instead.
    await this.redis.del(key);
    return true;
  }
}
