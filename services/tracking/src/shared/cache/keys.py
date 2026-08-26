"""Cache key construction.

## Why every response key carries TWO identities

Every response key carries BOTH identities — `cognito_sub` and `user_id`.
`cognito_sub` is the ownership key every user-scoped read filters by
(`services/tracking/CLAUDE.md` §5b); `user_id` is the internal `usr_` id. Both
travel so a key is unambiguous under either identity model, and so the per-user
index below can be reconstructed from either.

## Why a builder may answer `None`

`user_id` is resolved lazily, over gRPC to Users, and that resolution is allowed
to fail: `log_identity._resolve_quietly` swallows `UnknownUserError`,
`grpc.RpcError` and everything else, because enriching a log line must never fail
a request. So a fully authenticated caller can reach a handler with
`user_id is None`.

Formatting that `None` into a key would produce the literal string
`tracking:order:v1:<sub>:None:<order_id>` — which is a DIFFERENT key per sub, so
it does not leak across users by itself. But the `None` segment is a lie about
what the entry is scoped by, and the per-user index keyed on the same `None`
would collapse. Answering `None` instead makes the route skip caching for that
request entirely: it pays a MISS, serves from MySQL, and writes nothing. A
request that cannot be keyed correctly is not cached at all.

## Why the list key is a hash

`order_ids` is an arbitrary caller-supplied list of up to `MAX_BATCH_ORDER_IDS`
(100) ids. Keying on the raw list would make the key length proportional to the
request and the key SPACE combinatorial. Sorting and deduplicating first, then
hashing, collapses every ordering and every repetition of one set onto one
fixed-length key — which is both a cardinality bound and a hit-rate improvement,
since two clients asking for the same orders in different orders now share an
entry.
"""

from __future__ import annotations

import hashlib

#: Bumped when a cached DTO's shape changes, which mass-invalidates every entry
#: of that shape without touching Redis: the old keys simply stop being read and
#: expire on their own TTL.
VERSION = "v1"

#: The number of colon-separated segments that make up a key's PREFIX — the only
#: part of a key that may appear in a span attribute, a metric dimension or a log
#: line. Everything after it is identity.
_PREFIX_SEGMENTS = 3


class CacheKeys:
    """Namespace for the key builders. No state; never instantiated."""

    @staticmethod
    def tracking_order(
        cognito_sub: str, user_id: str | None, order_id: str
    ) -> str | None:
        """Key for `GET /v1/trackings/{order_id}`, or None if unkeyable."""
        if not user_id:
            return None
        return f"tracking:order:{VERSION}:{cognito_sub}:{user_id}:{order_id}"

    @staticmethod
    def tracking_list(
        cognito_sub: str, user_id: str | None, order_ids: list[str]
    ) -> str | None:
        """Key for `GET /v1/trackings?order_ids=`, or None if unkeyable.

        Normalizes (sort + dedup) BEFORE hashing, so `?order_ids=b,a` and
        `?order_ids=a,b,a` are one key.
        """
        if not user_id:
            return None
        digest = _hash_order_ids(order_ids)
        return f"tracking:list:{VERSION}:{cognito_sub}:{user_id}:{digest}"

    @staticmethod
    def identity(cognito_sub: str) -> str:
        """Key for the `cognito_sub -> user_id` mapping.

        Never `None`: this is the cache consulted to OBTAIN a `user_id`, so it
        cannot require one. Keyed on the sub alone.
        """
        return f"identity:sub-to-user:{VERSION}:{cognito_sub}"

    @staticmethod
    def user_index(cognito_sub: str, user_id: str) -> str:
        """Key of the Redis SET holding this user's live response keys.

        Required because a list key embeds a HASH of an arbitrary id list and
        therefore cannot be reconstructed at invalidation time. `KEYS` and `SCAN`
        are the wrong answer: both are O(N) over the whole keyspace, and `KEYS`
        blocks the server while it runs.
        """
        return f"tracking:index:{VERSION}:{cognito_sub}:{user_id}"

    @staticmethod
    def prefix_of(key: str) -> str:
        """The telemetry-safe prefix: everything up to and including `v1`.

        A full key carries `cognito_sub` and `user_id`. A span is an export
        destination like any other, and a CloudWatch dimension VALUE is
        cardinality the account is billed for, so neither ever sees more than
        this.
        """
        return ":".join(key.split(":")[:_PREFIX_SEGMENTS])


def _hash_order_ids(order_ids: list[str]) -> str:
    """Normalize then hash: sorted, deduplicated, newline-joined, sha256.

    `sorted(set(...))` is the normalization; the newline join is a separator that
    cannot appear inside an order id, so `["ab", "c"]` and `["a", "bc"]` cannot
    collide. Truncated to 16 hex characters — 64 bits, which for a keyspace of at
    most a few million live list entries makes a collision negligible, while
    keeping the key short enough to read in `redis-cli`.

    sha256 rather than `hash()`: Python's built-in string hash is salted per
    process (PYTHONHASHSEED), so two replicas would compute DIFFERENT keys for
    the same request and the cache would never hit across them.
    """
    normalized = "\n".join(sorted(set(order_ids)))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
