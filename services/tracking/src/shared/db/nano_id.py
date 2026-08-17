"""The one place the id format is defined for this service — see [[nano-id]].

Stripe-style `prefix_nanoid`: a fixed per-entity prefix, an underscore, then a
fixed-width random portion — the same shape as Users' `usr_` and Orders' `ord_`.

ALPHABET is letters and digits only. nanoid's default adds `_` and `-`, and those
two characters are why this configuration exists: an id is pasted into a shell, a
URL, a log grep and a CSV, and a leading `-` reads as a flag while `_` disappears
against an underscored column name. Restricting the alphabet costs nothing —
62^24 is MORE entropy than the 64^21 it replaces, so collision risk goes down,
not up.

LENGTH is the random portion only. A stored id is PREFIX_LENGTH + LENGTH = 28
characters, which is what every id-bearing database column must be sized for.
Getting that wrong truncates silently in MySQL rather than erroring.

The same three values are defined in Users (`shared/id/nano-id.ts`) and Orders
(`Orders.Infrastructure/Id/NanoId.cs`). They are a CROSS-SERVICE CONTRACT: ids
cross service boundaries in headers, envelopes and foreign keys, so a service that
disagrees about the alphabet or the length produces ids the others reject.
Changing any of them means changing all three together.

Only ONE entity prefix is defined here (`trk_`, for `Tracking`). `Tracking_History`
has a composite primary key `(tracking_id, status)` and the spec's table lists no
`id` column at all, so it gets no prefix and no generated id — see the note on
`TrackingHistory` in `features/tracking/domain/models.py`. `req_` sits alongside
it because the correlation id (`shared/logging/request_id.py`) is the same format
by design, and a second alphabet or a second notion of "how long" is exactly what
this class exists to prevent.
"""

from __future__ import annotations

import re
from typing import Final

from nanoid import generate


class NanoIdConfig:
    """The id format, as data. Every consumer derives from these values.

    A namespace class rather than a frozen dataclass: nothing here is ever
    instantiated or parameterized — there is exactly one id format for the
    service — so an instance would only add a way to hold a second, divergent
    one. `Final` annotations pin the values, and the derived quantities are
    computed from them so a regex can never drift from what the generator
    actually produces.
    """

    #: Letters and digits only — no `_`, no `-`.
    ALPHABET: Final[str] = (
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    )

    #: Characters in the random portion, excluding the prefix.
    LENGTH: Final[int] = 24

    #: Every prefix is `xxx_` — three characters and an underscore.
    PREFIX_LENGTH: Final[int] = 4

    #: Prefix per generated id kind. `trk_` is the `Tracking` primary key;
    #: `req_` is the cross-service correlation id, which shares this format.
    TRACKING: Final[str] = "trk_"
    REQUEST: Final[str] = "req_"

    #: Every prefix this service mints, so a test can assert the whole set at
    #: once (all `xxx_`, all unique) instead of naming them one by one.
    PREFIXES: Final[tuple[str, ...]] = (TRACKING, REQUEST)

    #: Total stored width: what an id column must hold.
    TOTAL_LENGTH: Final[int] = PREFIX_LENGTH + LENGTH

    @classmethod
    def pattern(cls, prefix: str) -> re.Pattern[str]:
        """A compiled regex matching a full prefixed id.

        Built from the values above rather than written out, so it cannot drift
        from what the generator actually produces. `re.escape` on the prefix
        because a caller could reasonably pass something with a regex
        metacharacter in it; ours never do, but a pattern that silently means
        something else is not a failure mode worth leaving open.
        """
        return re.compile(rf"{re.escape(prefix)}[A-Za-z0-9]{{{cls.LENGTH}}}")

    # ─── One factory per prefix ──────────────────────────────────────────────
    # Call sites say `NanoIdConfig.new_tracking_id()` rather than repeating a
    # raw `"trk_"`, so a typo is impossible instead of producing a row with an
    # unrecognisable id. `_assert_every_prefix_has_a_factory` below turns a
    # missing one into an import-time failure, which is the only way the two
    # lists can be kept from drifting in a language with no exhaustive mapping.

    @classmethod
    def _mint(cls, prefix: str) -> str:
        """The single generation path. Every factory below routes through it."""
        return f"{prefix}{generate(cls.ALPHABET, cls.LENGTH)}"

    @classmethod
    def new_tracking_id(cls) -> str:
        """A fresh `trk_`-prefixed id for a `Tracking` row."""
        return cls._mint(cls.TRACKING)

    @classmethod
    def new_request_id(cls) -> str:
        """A fresh `req_`-prefixed cross-service correlation id."""
        return cls._mint(cls.REQUEST)


def _assert_every_prefix_has_a_factory() -> None:
    """Fail at IMPORT time if a prefix was added without its factory.

    Python has no exhaustive mapping over a set of constants, so nothing would
    otherwise stop someone adding `INVOICE = "inv_"` and never writing
    `new_invoice_id()` — leaving callers to pass raw strings again, which is
    exactly what this class exists to prevent. TypeScript enforces the same rule
    in Users with a mapped type; this is the runtime equivalent, and it runs on
    import so the failure lands the moment the module loads rather than the
    first time that id kind is minted.

    Naming is the contract: prefix `trk_` requires `new_trk_id` or, preferably,
    a factory whose name ends in the prefix's word. Rather than guess at word
    forms, the check is structural — one `new_*_id` classmethod per prefix.
    """
    factories = {
        name
        for name in vars(NanoIdConfig)
        if name.startswith("new_") and name.endswith("_id")
    }
    if len(factories) != len(NanoIdConfig.PREFIXES):
        msg = (
            f"NanoIdConfig declares {len(NanoIdConfig.PREFIXES)} prefixes "
            f"{NanoIdConfig.PREFIXES} but {len(factories)} factories "
            f"{sorted(factories)}. Every prefix needs its own new_*_id() "
            "classmethod — see the class docstring."
        )
        raise RuntimeError(msg)


_assert_every_prefix_has_a_factory()


#: Kept as a module-level alias so existing imports keep reading naturally.
#: The prefix belongs to the config; this is the same object, not a second copy.
TRACKING_PREFIX: Final[str] = NanoIdConfig.TRACKING


def new_id(prefix: str) -> str:
    """Return a fresh `prefix_nanoid`, e.g. `trk_7gK3mP1vXz9wLq2bN8rRt4Yc`.

    Kept for the one caller that resolves a prefix dynamically. Prefer the typed
    factories (`NanoIdConfig.new_tracking_id()`) everywhere else: they cannot be
    called with a prefix that does not exist.
    """
    return NanoIdConfig._mint(prefix)  # noqa: SLF001 - same module, one generation path


def new_tracking_id() -> str:
    """Return a fresh `trk_`-prefixed id for a `Tracking` row.

    A thin alias for `NanoIdConfig.new_tracking_id()`, kept so existing imports
    keep working; it delegates rather than re-implementing.
    """
    return NanoIdConfig.new_tracking_id()
