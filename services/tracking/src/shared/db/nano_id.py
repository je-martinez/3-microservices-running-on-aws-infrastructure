"""Prefixed nano-IDs, per the nano-id convention.

Stripe-style `prefix_nanoid`: a fixed per-entity prefix, an underscore, then a
21-char URL-safe Nano ID — the same shape as Users' `usr_` and Orders' `ord_`.

Only ONE prefix is defined here (`trk_`, for `Tracking`). `Tracking_History` has a
composite primary key `(tracking_id, status)` and the spec's table lists no `id`
column at all, so it gets no prefix and no generated id — see the note on
`TrackingHistory` in `features/tracking/domain/models.py`.
"""

from typing import Final

from nanoid import generate

# Matches the convention's 21-char Nano ID and the VARCHAR(21) storage width the
# spec's data model declares for id columns.
NANO_ID_SIZE: Final[int] = 21

TRACKING_PREFIX: Final[str] = "trk_"


def new_id(prefix: str) -> str:
    """Return a fresh `prefix_nanoid`, e.g. `trk_wldA4A0WwZAKUmV6nQpXt`."""
    return f"{prefix}{generate(size=NANO_ID_SIZE)}"


def new_tracking_id() -> str:
    """Return a fresh `trk_`-prefixed id for a `Tracking` row."""
    return new_id(TRACKING_PREFIX)
