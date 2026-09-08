import { customAlphabet } from "nanoid";

/**
 * CONTRACT: EVERY prefix this service mints lives in this one map — a prefix kept
 * beside its consumer cannot be audited for collisions. MODEL keys are Prisma model
 * names (the client extension looks a model up by name to stamp `id`); non-model
 * entries are minted outside the ORM and carry a descriptive key.
 * See [[nano-id]]
 */
const PREFIXES = {
  // Prisma models — looked up by model name by the client extension.
  User: "usr_",
  UsersCognitoData: "ucd_",
  UsersCognitoEvent: "cge_",
  // Not persisted: the per-request correlation id ([[2026-08-15-request-id-correlation-design]]).
  Request: "req_",
  // Not persisted: the SQS envelope's idempotency key, minted per published event.
  Event: "evt_",
} as const;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const LENGTH = 24;
const PREFIX_LENGTH = 4;

type PrefixKey = keyof typeof PREFIXES;

/**
 * Forces one factory per prefix: adding a key to PREFIXES without its
 * `new<Key>Id()` factory is a compile error, so callers cannot fall back to
 * passing raw prefix strings.
 */
type IdFactories = { [K in PrefixKey as `new${K}Id`]: () => string };

/**
 * CONTRACT: ALPHABET, LENGTH and PREFIX_LENGTH are a CROSS-SERVICE contract, mirrored
 * in Orders and Tracking. Ids cross boundaries in headers, envelopes and foreign
 * keys, so changing any of the three means changing all three together. Letters and
 * digits only (nanoid's default `_`/`-` break shell, URL and CSV pasting); a stored
 * id is 28 characters, and an undersized column truncates silently in MySQL.
 * See [[nano-id]]
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
    // Reads the module-level constants: the `satisfies` clause below widens `this`
    // inside a getter, so `this.LENGTH` would be `unknown`.
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
  // Call sites use these rather than a raw `"usr_"`, so a typo is a compile error
  // instead of a row with an unrecognisable id.
  newUserId: () => mint(PREFIXES.User),
  newUsersCognitoDataId: () => mint(PREFIXES.UsersCognitoData),
  newUsersCognitoEventId: () => mint(PREFIXES.UsersCognitoEvent),
  newRequestId: () => mint(PREFIXES.Request),
  newEventId: () => mint(PREFIXES.Event),
} as const satisfies IdFactories & Record<string, unknown>;

/** The raw generator, built once at module load — `customAlphabet` returns a closure. */
const generate = customAlphabet(ALPHABET, LENGTH);

function mint(prefix: string): string {
  return `${prefix}${generate()}`;
}

/**
 * CONTRACT: Spell out the MODEL prefixes; do NOT derive this from PREFIXES wholesale.
 * That map also holds non-model ids (`Request`, `Event`), and handing Prisma a key
 * that is not a model is a silent no-op the day someone names a model `Request`.
 * See [[nano-id]]
 */
export const MODEL_ID_PREFIXES: Record<string, string> = {
  User: PREFIXES.User,
  UsersCognitoData: PREFIXES.UsersCognitoData,
  UsersCognitoEvent: PREFIXES.UsersCognitoEvent,
};

/**
 * A fresh `prefix_nanoid`, e.g. `usr_7gK3mP1vXz9wLq2bN8rRt4Yc`. Prefer the typed
 * factories at call sites; this stays exported for the Prisma extension, which only
 * knows a prefix string looked up by model name.
 */
export function generateId(prefix: string): string {
  return mint(prefix);
}
