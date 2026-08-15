import { customAlphabet } from "nanoid";

/**
 * EVERY prefix this service mints, entity and non-entity alike.
 *
 * One map rather than a constant per call site: a prefix that lives beside its
 * consumer is a prefix nobody can audit for collisions, and `req_` proved the
 * point — it sat in `shared/logging/request-id.ts` while the entity prefixes
 * lived here, so nothing could see both at once.
 *
 * MODEL keys are Prisma model names: the client extension looks a model up by
 * name to stamp `id` on create. NON-MODEL entries are ids minted outside the
 * ORM, so they carry a descriptive key instead.
 */
const PREFIXES = {
  // Prisma models — looked up by model name by the client extension.
  User: "usr_",
  UsersCognitoData: "ucd_",
  UsersCognitoEvent: "cge_",
  // Not persisted: the per-request correlation id ([[request-id]]).
  Request: "req_",
} as const;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const LENGTH = 24;
const PREFIX_LENGTH = 4;

type PrefixKey = keyof typeof PREFIXES;

/**
 * Forces one factory per prefix.
 *
 * This mapped type is the point: adding a key to PREFIXES without adding its
 * `new<Key>Id()` factory is a COMPILE ERROR, so the two can never drift. Without
 * it a new prefix would quietly have no factory and callers would go back to
 * passing raw strings — which is the thing this file exists to stop.
 */
type IdFactories = { [K in PrefixKey as `new${K}Id`]: () => string };

/**
 * The one place the id format is defined for this service — see [[nano-id]].
 *
 * ALPHABET is letters and digits only. nanoid's default adds `_` and `-`, and
 * those two characters are why this exists: an id is pasted into a shell, a URL,
 * a log grep and a CSV, and a leading `-` reads as a flag while `_` disappears
 * against an underscored column name. Restricting the alphabet costs nothing —
 * 62^24 is MORE entropy than the 64^21 it replaces, so collision risk goes down,
 * not up.
 *
 * LENGTH is the nanoid portion only. A stored id is PREFIX_LENGTH + LENGTH = 28
 * characters, which is what every id-bearing database column must be sized for.
 * Getting that wrong truncates silently in MySQL rather than erroring.
 *
 * The same three values are defined in Orders (`Orders.Infrastructure/Id/NanoId.cs`)
 * and Tracking (`shared/db/nano_id.py`). They are a CROSS-SERVICE CONTRACT: ids
 * cross service boundaries in headers, envelopes and foreign keys, so a service
 * that disagrees about the alphabet or the length produces ids the others reject.
 * Changing any of them means changing all three together.
 */
export const NanoIdConfig = {
  /** Letters and digits only — no `_`, no `-`. */
  ALPHABET,
  /** Characters in the random portion, excluding the prefix. */
  LENGTH,
  /** Every prefix is `xxx_` — three characters and an underscore. */
  PREFIX_LENGTH,

  PREFIXES,

  /** Total stored width: what an id column must hold. */
  get TOTAL_LENGTH(): number {
    // Reads the module-level constants rather than `this`: the `satisfies`
    // clause below widens `this` inside a getter, so `this.LENGTH` would be
    // `unknown` here.
    return PREFIX_LENGTH + LENGTH;
  },

  /**
   * Matches a full prefixed id. Built from the values above rather than written
   * out, so it cannot drift from what the generator actually produces.
   */
  pattern(prefix: string): RegExp {
    return new RegExp(`^${prefix}[A-Za-z0-9]{${LENGTH}}$`);
  },

  // ─── One factory per prefix ────────────────────────────────────────────────
  // Call sites say `NanoIdConfig.newUserId()` rather than repeating a raw
  // `"usr_"` string, so a typo is a compile error instead of a row with an
  // unrecognisable id. `satisfies IdFactories` is what enforces completeness.
  newUserId: () => mint(PREFIXES.User),
  newUsersCognitoDataId: () => mint(PREFIXES.UsersCognitoData),
  newUsersCognitoEventId: () => mint(PREFIXES.UsersCognitoEvent),
  newRequestId: () => mint(PREFIXES.Request),
} as const satisfies IdFactories & Record<string, unknown>;

/**
 * The raw generator. Created once at module load — `customAlphabet` builds a
 * closure, and rebuilding it per call would be pure overhead.
 */
const generate = customAlphabet(ALPHABET, LENGTH);

function mint(prefix: string): string {
  return `${prefix}${generate()}`;
}

/**
 * Prefix per Prisma MODEL, for the client extension, which resolves a prefix by
 * model name at runtime and so cannot use the typed factories above.
 *
 * Spelled out rather than derived from PREFIXES wholesale: that map also holds
 * non-model ids (`Request`), and handing Prisma a key that is not a model
 * would be a silent no-op waiting for someone to name a model `Request`.
 */
export const MODEL_ID_PREFIXES: Record<string, string> = {
  User: PREFIXES.User,
  UsersCognitoData: PREFIXES.UsersCognitoData,
  UsersCognitoEvent: PREFIXES.UsersCognitoEvent,
};

/**
 * A fresh `prefix_nanoid`, e.g. `usr_7gK3mP1vXz9wLq2bN8rRt4Yc`.
 *
 * Prefer the typed factories (`NanoIdConfig.newUserId()`) at call sites. This
 * stays exported for the Prisma extension, which only knows a prefix STRING
 * looked up by model name.
 */
export function generateId(prefix: string): string {
  return mint(prefix);
}
