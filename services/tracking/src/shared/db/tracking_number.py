"""The human-readable tracking number minted for every `tracking` row.

Distinct from `nano_id.py` on purpose, even though both mint identifiers here.
`trk_…` is the row's PRIMARY KEY — a machine identifier, referenced by nothing a
person reads. This one is the opposite: it is the string an email quotes and a
customer reads back over the phone, so it is optimized for being transcribed
rather than for being compact.

## `3MRAI-XXXX-XXXX-XXXX`, and why it is OURS

A tracking row is created at `PLACED`, long before any carrier is involved (see
`commands/create_tracking.py`), so there is no carrier number to record — the
value is this system's own identifier and the `3MRAI-` prefix says so. Minting it
at creation rather than when a shipment is actually handed over keeps the column
NOT NULL and always populated, so no template has to branch on its absence.

## `secrets`, never `random`

`random` is a Mersenne Twister seeded from the clock: observing a handful of
outputs is enough to reconstruct its state and predict every subsequent one. A
tracking number is quoted in an email and appears in URLs, so a guessable one
would let somebody enumerate other people's shipments. `secrets` is backed by the
OS CSPRNG (`urandom`), which is what this needs and costs nothing here — one
number is minted per tracking, not per request.

## The alphabet, and why it is not `string.ascii_uppercase + digits`

Four characters are removed from the 36 uppercase alphanumerics: `I`, `O`, `0`
and `1`. They are the pairs a reader confuses when transcribing from an email or
reading aloud, and a tracking number's whole job is to survive exactly that trip.
The alphabet is a module constant rather than an inline literal so the entropy
calculation below stays checkable against it.

## Entropy

12 characters from a 32-symbol alphabet is 5 bits each, i.e. **60 bits** — about
1.15e18 values. The birthday bound says a 50% chance of any collision needs
~1.3e9 rows; at the volume this service will ever see, a repeat is not a
practical concern. It is not left to luck either: `tracking.tracking_number` is
UNIQUE, so a collision is a failed INSERT rather than two shipments sharing a
number.
"""

from __future__ import annotations

import secrets
from typing import Final

#: Names the issuing system. A number is recognizable as ours at a glance, and a
#: carrier's real number (should one ever be recorded) is never mistaken for it.
TRACKING_NUMBER_PREFIX: Final[str] = "3MRAI"

#: Uppercase alphanumerics minus `I`, `O`, `0`, `1` — see the module docstring.
#: 32 symbols exactly, which is what makes each character worth 5 whole bits.
TRACKING_NUMBER_ALPHABET: Final[str] = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

#: Characters per group, and the number of groups. Grouping is for the reader:
#: `3MRAI-K7QD-2XBM-9PWA` is transcribed correctly far more often than the same
#: twelve characters run together.
GROUP_SIZE: Final[int] = 4
GROUP_COUNT: Final[int] = 3

#: Separator between the prefix and every group.
SEPARATOR: Final[str] = "-"

#: Total width of a rendered number, `len("3MRAI") + 3 * len("-XXXX")` = 20. Used
#: by the column definition so the two cannot drift apart.
TRACKING_NUMBER_LENGTH: Final[int] = (
    len(TRACKING_NUMBER_PREFIX)
    + GROUP_COUNT * (len(SEPARATOR) + GROUP_SIZE)
)


def new_tracking_number() -> str:
    """Return a fresh number, e.g. `3MRAI-K7QD-2XBM-9PWA`.

    `secrets.choice` per character rather than `secrets.token_hex` or a
    base32-encoded blob: the alphabet is deliberately not a power-of-two-aligned
    encoding (it excludes the confusable characters), so there is nothing to
    encode from — and `choice` draws uniformly from the CSPRNG without the modulo
    bias a hand-rolled `randbelow(len(alphabet))` mapping could introduce.
    """
    groups = (
        "".join(secrets.choice(TRACKING_NUMBER_ALPHABET) for _ in range(GROUP_SIZE))
        for _ in range(GROUP_COUNT)
    )
    return SEPARATOR.join((TRACKING_NUMBER_PREFIX, *groups))
