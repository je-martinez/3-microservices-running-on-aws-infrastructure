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
    text,
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

# The one tag value this service ever writes: the label marking a tracking as an
# E2E fixture, and the exact string `DELETE /v1/trackings/e2e-cleanup` selects on.
#
# Shared with Users VERBATIM — space, capitals and all — because both services'
# teardowns select on this same string and a near-miss ("e2e-source") would clean
# up nothing while looking correct.
#
# It lives HERE, in the domain, rather than beside the HTTP header that requests
# it: the tag is a value persisted on a row, so the transport-free command layer
# needs it and must not import a FastAPI module to get it.
E2E_SOURCE_TAG = "E2E Source"

# Width of the `cognito_sub` column. A Cognito `sub` is a 36-char UUID today, but
# 255 is what Orders' `order.cognito_sub` uses (verified in
# `OrderConfiguration.cs`), and the two MySQL services storing the same value under
# the same name should not disagree on its width.
COGNITO_SUB_LENGTH = 255


class Tracking(Base, AuditMixin):
    """A tracking record — one per order.

    Created exclusively through `POST /v1/trackings/init-tracking`; there is no
    other write path that brings one into existence.
    """

    __tablename__ = "tracking"

    #: Prefixed nano-ID (`trk_...`), per the nano-id convention.
    id: Mapped[str] = mapped_column(String(ID_LENGTH), primary_key=True)

    #: The INTERNAL `usr_` id, as Orders resolved it from Users. Stored for
    #: reporting and cross-service joins — NOT the key the user-scoped reads
    #: filter by. See `cognito_sub`.
    user_id: Mapped[str] = mapped_column(String(ID_LENGTH), nullable=False)

    #: The owner's Cognito `sub`, and **the ownership key for the REST reads**.
    #:
    #: Two identities describe the same person here and they are not
    #: interchangeable. `user_id` above is the internal `usr_` id that Orders
    #: resolves through Users and sends over gRPC. But an end user's request
    #: arrives at this service carrying the gateway-injected `x-user-id` header,
    #: which holds the Cognito `sub` — `proxy_set_header x-user-id $jwt_sub` in
    #: `infra/modules/compute/nginx/nginx.conf`, and the equivalent mapping at the
    #: production gateway.
    #:
    #: So scoping a REST read by `user_id` compares a `sub` against a `usr_` id.
    #: Those never match, which means every user-scoped read would answer 404 —
    #: including for the caller's own tracking — while looking perfectly
    #: implemented. Orders hit exactly this and settled on persisting BOTH columns
    #: and filtering reads by `cognito_sub`; this column is that same fix.
    #:
    #: Nullable, because the field is optional on the wire (see the .proto): a
    #: caller that predates it is accepted rather than failed. Such a row is simply
    #: unreachable over the user-scoped reads — never mis-attributed to someone
    #: else, since NULL matches no caller's sub.
    cognito_sub: Mapped[str | None] = mapped_column(
        String(COGNITO_SUB_LENGTH), nullable=True
    )

    #: UNIQUE — one tracking per order. Enforced at the database, not just in the
    #: application, so a duplicate creation cannot race past a pre-check.
    order_id: Mapped[str] = mapped_column(String(ID_LENGTH), nullable=False)

    #: One of the four TrackingStatus values. Stored as a plain VARCHAR rather
    #: than a MySQL ENUM: the lookup/enum trade-off aside, the REST surface carries
    #: it as a string, and widening a native ENUM is a DDL change.
    status: Mapped[str] = mapped_column(String(STATUS_LENGTH), nullable=False)

    #: Point-in-time snapshot of the delivery address, forwarded as-is by Orders.
    #: JSON, and ONLY on this table — the address is fixed for the lifetime of a
    #: tracking, so `tracking_history` deliberately does NOT carry it (the spec is
    #: explicit). Nullable because proto3 has no null: an address absent upstream
    #: may arrive as an empty message. PII — never log it.
    shipping_address: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    #: Free-form labels on the row. Today exactly one value is ever written —
    #: `"E2E Source"`, the tag `DELETE /v1/trackings/e2e-cleanup` selects on.
    #:
    #: **JSON, not an array type.** Users stores the same tags as a Postgres
    #: `text[]`; MySQL has no array type at all, so the portable equivalent here is
    #: a JSON array, queried with `JSON_CONTAINS` (verified against MySQL 8.0.46).
    #: The alternative — a child `tracking_tag` table — would be the right shape
    #: for tags that are queried, joined and indexed; these are neither, and a
    #: second table plus a join for a single harness label is a schema nobody would
    #: choose if the tag were the only requirement.
    #:
    #: **NOT NULL with a `[]` default, never NULL.** A nullable tags column would
    #: give "no tags" two spellings, and `JSON_CONTAINS(NULL, ...)` is NULL rather
    #: than false — so a NULL row is excluded from the cleanup's predicate for a
    #: reason that reads like an accident. The default is applied server-side too
    #: (`server_default`), so a row inserted by anything that does not go through
    #: this model — a migration backfill, a manual fix — is still `[]`.
    #:
    #: `default=list`, not `default=[]`: a mutable default would be ONE list shared
    #: by every instance that took it.
    tags: Mapped[list[str]] = mapped_column(
        JSON, nullable=False, default=list, server_default=text("(JSON_ARRAY())")
    )

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
        # The REST reads filter on (order_id, cognito_sub) together — cognito_sub,
        # NOT user_id, is the ownership key (see the column's docstring) — so this
        # is the composite that actually serves them. The unique constraint above
        # already covers the unscoped gRPC lookup by order_id alone.
        Index("idx_tracking_order_id_cognito_sub", "order_id", "cognito_sub"),
        # Kept: `user_id` remains a real reporting/join key even though no read
        # scopes by it.
        Index("idx_tracking_order_id_user_id", "order_id", "user_id"),
        Index("idx_tracking_user_id", "user_id"),
        Index("idx_tracking_cognito_sub", "cognito_sub"),
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

    **No `tags` column, deliberately** — unlike `cognito_sub`, which this table
    does denormalize. The two are not the same kind of fact. `cognito_sub` is the
    row's ownership context, and the reads scope by it, so a transition row has to
    carry it to be self-describing. `tags` is consumed by exactly one query, the
    E2E cleanup, and that query does not need it here: history rows are reached
    through their parent's `tracking_id` (the FK), so "the children of every tagged
    tracking" is already expressible without copying the tag down.

    Copying it would actively make things worse. The tag would then have two
    sources of truth that a partial update could put out of step, and a history row
    could end up tagged while its parent is not (or the reverse) — a state with no
    meaning, since a transition is not independently an "E2E fixture", its shipment
    is. The cascade in `soft_delete_by_tag` follows the FK for precisely this
    reason.
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

    #: Denormalized off the parent, exactly like `user_id` and `order_id` above.
    #:
    #: This table DOES carry the Cognito sub while it deliberately does not carry
    #: `shipping_address`, and the difference is not "fixed for the tracking's
    #: lifetime" — `user_id` and `order_id` are equally fixed and are both here.
    #: The address is omitted because it is bulky PII that says nothing about a
    #: transition. `cognito_sub` is the opposite: it is the row's ownership
    #: context, and the table already denormalizes the rest of that context (and
    #: indexes it, below) precisely so a transition row is self-describing.
    #:
    #: Leaving it off would strand that: the existing
    #: `(order_id, user_id)` index would key this table by an identity no read
    #: surface filters by any more. Orders makes the same call — `order_details`
    #: carries both `user_id` and `cognito_sub`, denormalized off `order`.
    cognito_sub: Mapped[str | None] = mapped_column(
        String(COGNITO_SUB_LENGTH), nullable=True
    )

    #: Timestamp of THIS status transition.
    datetime_: Mapped[datetime] = mapped_column(
        "datetime", DateTime, nullable=False
    )

    tracking: Mapped[Tracking] = relationship(back_populates="history")

    __table_args__ = (
        Index(
            "idx_tracking_history_order_id_cognito_sub", "order_id", "cognito_sub"
        ),
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
