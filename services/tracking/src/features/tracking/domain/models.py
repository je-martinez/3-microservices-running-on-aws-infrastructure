"""SQLAlchemy models for `tracking` and `tracking_history` (JE-88).

Mirrors the Data Model tables in
`docs/domains/tracking/specs/tracking-service-design.md`. Both tables carry the
standard audit fields and soft-delete (`AuditMixin`), and column names are
`snake_case` per the db-naming convention.
"""

from datetime import datetime

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    case,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.features.tracking.domain.status import STATUS_ORDER
from src.shared.db.base import AuditMixin, Base

# Width of every id-bearing column.
#
# The spec's Data Model tables say VARCHAR(21), but that is the width of the Nano
# ID ALONE — it does not account for the 4-char `trk_` / `ord_` / `usr_` prefix the
# nano-id convention mandates, so a real id (25 chars) would be TRUNCATED by it.
# Orders hit the same thing and settled on VARCHAR(26) (verified live: its
# `order.id` column is varchar(26) holding 25-char values). Matching that width
# here keeps the two MySQL services identical and leaves one spare character.
ID_LENGTH = 26

# The spec's declared width for the status column.
STATUS_LENGTH = 50


class Tracking(Base, AuditMixin):
    """A tracking record — one per order.

    Created exclusively through the `CreateTracking` gRPC handler; there is no
    REST POST.
    """

    __tablename__ = "tracking"

    #: Prefixed nano-ID (`trk_...`), per the nano-id convention.
    id: Mapped[str] = mapped_column(String(ID_LENGTH), primary_key=True)

    user_id: Mapped[str] = mapped_column(String(ID_LENGTH), nullable=False)

    #: UNIQUE — one tracking per order. Enforced at the database, not just in the
    #: application, so a duplicate CreateTracking cannot race past a pre-check.
    order_id: Mapped[str] = mapped_column(String(ID_LENGTH), nullable=False)

    #: One of the four TrackingStatus values. Stored as a plain VARCHAR rather
    #: than a MySQL ENUM: the lookup/enum trade-off aside, the proto and the REST
    #: PUT both carry it as a string, and widening a native ENUM is a DDL change.
    status: Mapped[str] = mapped_column(String(STATUS_LENGTH), nullable=False)

    #: Point-in-time snapshot of the delivery address, forwarded as-is by Orders.
    #: JSON, and ONLY on this table — the address is fixed for the lifetime of a
    #: tracking, so `tracking_history` deliberately does NOT carry it (the spec is
    #: explicit). Nullable because proto3 has no null: an address absent upstream
    #: may arrive as an empty message. PII — never log it.
    shipping_address: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    #: Timestamp of the CURRENT status. Distinct from `updated_at`: this moves
    #: only on a status transition, whereas `updated_at` moves on any write.
    datetime_: Mapped[datetime] = mapped_column(
        "datetime", DateTime, nullable=False
    )

    history: Mapped[list["TrackingHistory"]] = relationship(
        back_populates="tracking",
        cascade="save-update, merge",
        # See `TrackingHistory.ordering()` — timestamp first, progression
        # position as the tiebreaker. A bare `datetime` sort is NOT enough.
        order_by=lambda: TrackingHistory.ordering(),
        lazy="selectin",
    )

    __table_args__ = (
        UniqueConstraint("order_id", name="uq_tracking_order_id"),
        # The REST reads filter on (order_id, user_id) together — see the
        # ownership rule in the design — so a composite index serves them, while
        # the unique constraint above already covers the unscoped gRPC lookup by
        # order_id alone.
        Index("idx_tracking_order_id_user_id", "order_id", "user_id"),
        Index("idx_tracking_user_id", "user_id"),
        Index("idx_tracking_deleted_at", "deleted_at"),
    )

    def __repr__(self) -> str:
        # Deliberately omits shipping_address — it is PII and must never reach a
        # log line via an accidental repr.
        return (
            f"Tracking(id={self.id!r}, order_id={self.order_id!r}, "
            f"status={self.status!r})"
        )


class TrackingHistory(Base, AuditMixin):
    """Immutable log of every status transition.

    **No surrogate id, by design.** The spec's table lists no `id` column and
    declares a composite primary key `(tracking_id, status)`; that key is already
    unique and meaningful, so adding a `trh_` nano-ID would introduce a second
    identity for the same row with nothing to reference it. This is why
    `shared/db/nano_id.py` defines only one prefix.

    A consequence worth naming: `(tracking_id, status)` means a tracking can hold
    **at most one row per status**, which is exactly the forward-only state
    machine's guarantee — the same status can never be entered twice. The PK and
    the state machine enforce the same invariant from two directions.
    """

    __tablename__ = "tracking_history"

    tracking_id: Mapped[str] = mapped_column(
        String(ID_LENGTH),
        ForeignKey("tracking.id", name="fk_tracking_history_tracking_id"),
        primary_key=True,
    )

    #: Part of the composite PK — see the class docstring.
    status: Mapped[str] = mapped_column(
        String(STATUS_LENGTH), primary_key=True
    )

    user_id: Mapped[str] = mapped_column(String(ID_LENGTH), nullable=False)
    order_id: Mapped[str] = mapped_column(String(ID_LENGTH), nullable=False)

    #: Timestamp of THIS status transition.
    datetime_: Mapped[datetime] = mapped_column(
        "datetime", DateTime, nullable=False
    )

    tracking: Mapped[Tracking] = relationship(back_populates="history")

    __table_args__ = (
        Index("idx_tracking_history_order_id_user_id", "order_id", "user_id"),
        Index("idx_tracking_history_deleted_at", "deleted_at"),
    )

    @classmethod
    def ordering(cls) -> tuple:
        """The ORDER BY for history: transition time, then progression position.

        The timestamp alone is NOT a deterministic sort, and this bit us in a
        real test against real MySQL. Two transitions can share a `datetime` —
        a carrier can send two updates inside the same second, and any code path
        that writes several transitions in one unit of work stamps them all with
        one `now`. When the timestamps tie, MySQL is free to return rows in
        primary-key order, which for `(tracking_id, status)` is ALPHABETICAL:
        DELIVERED, ON_THE_WAY, OUT_FOR_DELIVERY, SHIPPED — precisely reversed at
        the ends, so a caller would see a shipment delivered before it shipped.

        The tiebreaker maps each status to its index in the forward-only
        progression, so ties resolve into the only order that can be correct.
        """
        position = case(
            {status.value: index for index, status in enumerate(STATUS_ORDER)},
            value=cls.status,
        )
        return (cls.datetime_, position)

    def __repr__(self) -> str:
        return (
            f"TrackingHistory(tracking_id={self.tracking_id!r}, "
            f"status={self.status!r}, datetime={self.datetime_!r})"
        )
