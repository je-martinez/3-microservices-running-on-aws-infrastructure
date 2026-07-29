"""Persistence for `Tracking` / `TrackingHistory` (JE-88).

## The user-scoped vs unscoped read problem

Tracking's two read transports want the SAME query with ONE difference:

  * **gRPC** reads are inter-service and **unscoped** — any `order_id`, no
    per-user filter (the caller is trusted via `x-api-key`).
  * **REST** reads (Phase D) are **user-scoped** — filtered by `order_id` AND the
    caller's **Cognito sub**, so a tracking belonging to someone else is
    indistinguishable from one that does not exist.

Rather than duplicating each query in a scoped and an unscoped variant (four
near-identical methods that would drift), the read methods take an optional
`cognito_sub: str | None`. `None` means unscoped (gRPC); a value adds the ownership
predicate **to the query itself** — never fetch-then-compare, which would let a
non-owned row exist in memory and leak through a careless later change.

## Why the scope is `cognito_sub` and NOT `user_id`

The parameter is the Cognito `sub`, because that is what a real caller presents:
the gateway injects it as `x-user-id` (`proxy_set_header x-user-id $jwt_sub`).
`Tracking.user_id` holds the INTERNAL `usr_` id that Orders sends over gRPC — a
different value for the same person. Scoping by `user_id` therefore matches
nothing and 404s every read, including the caller's own; see
`Tracking.cognito_sub` in `models.py` for the full account. Orders filters its
reads by `cognito_sub` for exactly this reason.

## Soft-delete

Every read goes through `_live()`, which appends `deleted_at IS NULL`. There is no
path in this class that reads soft-deleted rows, and no method issues a SQL
`DELETE` — deletion, when it is ever needed, is stamping the audit columns.
"""

from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from src.features.tracking.domain.models import Tracking, TrackingHistory
from src.features.tracking.domain.status import TrackingStatus
from src.shared.audit.audit_actor import AuditActor
from src.shared.db.nano_id import new_tracking_id


def _utcnow() -> datetime:
    """Naive, whole-second UTC `datetime`, matching what the columns can hold.

    Two adjustments, both matching the storage rather than the clock:

    * **No tzinfo** — MySQL `DATETIME` carries no zone.
    * **No microseconds** — and this one is load-bearing. `sa.DateTime()` maps to
      `DATETIME` with fsp 0, and MySQL does not truncate the fractional part on
      write, it **ROUNDS** it (verified on 8.0.46: inserting `04:03:46.965829`
      stores `04:03:47`). So an in-memory entity keeping its microseconds
      disagrees with its own row — by up to a second, and in the wrong direction.

      That is invisible while everything reads from the database, which is why it
      survived Phase B. It surfaced the moment creation started rendering its
      response off the just-written entity: create reported
      `2026-07-29T04:03:46.965829Z` while the subsequent read of the same row
      reported `2026-07-29T04:03:47Z`. Two calls, one row, two timestamps — and the
      create response quoting an instant the database never held.

      Dropping the microseconds HERE, at the single place the write timestamp is
      minted, keeps the entity and the row identical by construction, so no caller
      has to know about the column's precision.
    """
    return datetime.now(UTC).replace(tzinfo=None, microsecond=0)


class TrackingRepository:
    """Reads and writes for the tracking aggregate.

    Takes a `Session` rather than opening its own: the caller decides whether this
    is a writer session (commands) or a reader session (queries), per ADR-0006.
    Purpose-built — not a generic repository — so every query stays inspectable.
    """

    def __init__(self, session: Session) -> None:
        self.session = session

    # ------------------------------------------------------------------ reads

    @staticmethod
    def _live(stmt: Select, model: type[Tracking] | type[TrackingHistory]) -> Select:
        """Exclude soft-deleted rows. Applied to every read in this class."""
        return stmt.where(model.deleted_at.is_(None))

    @staticmethod
    def _scoped(
        stmt: Select, model: type[Tracking], cognito_sub: str | None
    ) -> Select:
        """Add the ownership predicate when `cognito_sub` is given.

        `None` = unscoped (gRPC, trusted inter-service caller). A value = the REST
        reads' user scoping. Filtering here, inside the query, is what makes a
        non-owned tracking indistinguishable from a missing one.

        The predicate is on `cognito_sub`, not `user_id` — see the module
        docstring. A row whose `cognito_sub` is NULL (created before the field
        existed) matches no caller, which is the correct failure direction: it is
        invisible rather than attributed to the wrong person.
        """
        if cognito_sub is None:
            return stmt
        return stmt.where(model.cognito_sub == cognito_sub)

    def get_by_order_id(
        self, order_id: str, *, cognito_sub: str | None = None
    ) -> Tracking | None:
        """Return one tracking by `order_id`, or None.

        `cognito_sub="<sub>"` → scoped (`GET /v1/trackings/{orderId}`); a tracking
        owned by another user returns None, which the handler renders as `404` —
        never `403`, which would leak its existence.

        `cognito_sub=None` → **unscoped**: any order's tracking is returned. No
        served endpoint passes None any more — the gRPC reads that did were removed
        in JE-108 — and the only remaining internal caller is the TestMode
        progression, which advances a tracking it just created and has no caller
        identity to scope by. Reach it through `queries/get_my_trackings.py` from
        anything request-facing, never directly.

        History is loaded eagerly (`selectin` on the relationship), so both read
        endpoints get the tracking together with its history in one round trip
        without an N+1.
        """
        stmt = self._scoped(
            self._live(select(Tracking), Tracking).where(
                Tracking.order_id == order_id
            ),
            Tracking,
            cognito_sub,
        )
        return self.session.execute(stmt).scalar_one_or_none()

    def get_by_order_ids(
        self, order_ids: Sequence[str], *, cognito_sub: str | None = None
    ) -> list[Tracking]:
        """Return the trackings for `order_ids`, in one query.

        Ids that do not exist — or, when scoped, belong to another user — are
        simply **omitted** from the result, never reported as a per-id error. A
        caller passing ten ids and owning three gets back exactly three.

        An empty `order_ids` short-circuits: `IN ()` is not valid SQL everywhere
        and there is nothing to ask the database.
        """
        if not order_ids:
            return []

        stmt = self._scoped(
            self._live(select(Tracking), Tracking).where(
                Tracking.order_id.in_(list(order_ids))
            ),
            Tracking,
            cognito_sub,
        ).order_by(Tracking.created_at)
        return list(self.session.execute(stmt).scalars().all())

    def get_history(self, tracking_id: str) -> list[TrackingHistory]:
        """Return a tracking's live history, oldest transition first.

        Uses `TrackingHistory.ordering()` — timestamp, then progression position
        — the same expression the `Tracking.history` relationship sorts by, so
        both paths to the history agree. A bare `datetime` sort is not
        deterministic when two transitions share a timestamp; see that method.
        """
        stmt = (
            self._live(select(TrackingHistory), TrackingHistory)
            .where(TrackingHistory.tracking_id == tracking_id)
            .order_by(*TrackingHistory.ordering())
        )
        return list(self.session.execute(stmt).scalars().all())

    # ----------------------------------------------------------------- writes

    def create(
        self,
        *,
        order_id: str,
        user_id: str,
        cognito_sub: str | None = None,
        shipping_address: dict | None = None,
        status: TrackingStatus = TrackingStatus.SHIPPED,
        actor: AuditActor = AuditActor.CREATE_TRACKING,
        now: datetime | None = None,
    ) -> Tracking:
        """Create a tracking and its first history entry, in one unit of work.

        A tracking is never created without the matching history row: the record's
        initial status IS a transition, and the design's TestMode table counts it
        as one of the four entries a completed run leaves behind. Emitting both
        here makes that impossible to forget at a call site.

        Does NOT commit — the caller's `write_session` owns the transaction
        boundary, so creation and any follow-up work commit or roll back together.

        `cognito_sub` defaults to None so a caller that does not know it can still
        create — the wire field is optional (see the .proto). The resulting row is
        unreachable over the user-scoped REST reads and fully readable over gRPC.
        """
        moment = now or _utcnow()
        tracking = Tracking(
            id=new_tracking_id(),
            order_id=order_id,
            user_id=user_id,
            cognito_sub=cognito_sub,
            status=status.value,
            shipping_address=shipping_address,
            datetime_=moment,
        )
        self._stamp_created(tracking, actor, moment)
        self.session.add(tracking)

        self.append_history_entry(
            tracking=tracking,
            status=status,
            actor=actor,
            now=moment,
        )

        # Make the row (and its PK) visible to queries in this same transaction
        # without ending it.
        self.session.flush()
        return tracking

    def append_history_entry(
        self,
        *,
        tracking: Tracking,
        status: TrackingStatus,
        actor: AuditActor,
        now: datetime | None = None,
    ) -> TrackingHistory:
        """Append one immutable transition row for `tracking`.

        `user_id`, `order_id` and `cognito_sub` are copied off the tracking rather
        than taken as parameters: they are fixed for its lifetime, and accepting
        them would let a caller write a history row that disagrees with its parent
        about who owns it.
        """
        moment = now or _utcnow()
        entry = TrackingHistory(
            tracking_id=tracking.id,
            user_id=tracking.user_id,
            order_id=tracking.order_id,
            cognito_sub=tracking.cognito_sub,
            status=status.value,
            datetime_=moment,
        )
        self._stamp_created(entry, actor, moment)
        self.session.add(entry)
        return entry

    def update_status(
        self,
        *,
        tracking: Tracking,
        status: TrackingStatus,
        actor: AuditActor,
        now: datetime | None = None,
    ) -> Tracking:
        """Move `tracking` to `status` and log the transition.

        **Does not validate the transition.** The forward-only guards live in
        `domain/status.py` as pure functions, and the caller applies them — that
        keeps them usable by TestMode progression, which has no session at all.
        This method persists a decision already made.

        ## Why `history` is expired at the end

        `append_history_entry` adds the new row to the SESSION, not to the
        `tracking.history` collection. When `tracking` came from a read, that
        collection is already loaded (`lazy="selectin"`) and therefore **stale** —
        it still holds the transitions from before this update.

        That is invisible to a caller who re-reads the tracking, which is why it
        survived Phase B/C: the gRPC reads load history fresh. It surfaced the
        moment the carrier PUT rendered its response off the just-updated entity —
        the endpoint reported the NEW status alongside a history that did not
        contain it, i.e. a transition that had demonstrably happened and left no
        trace in the log it exists to write.

        Expiring the attribute makes the next access reload it (ordered by
        `TrackingHistory.ordering()`, like any other load), so the returned entity
        and its own row agree by construction and no caller has to know that
        appending went through the session.
        """
        moment = now or _utcnow()
        tracking.status = status.value
        tracking.datetime_ = moment
        self._stamp_updated(tracking, actor, moment)
        self.append_history_entry(
            tracking=tracking, status=status, actor=actor, now=moment
        )
        self.session.flush()
        self.session.expire(tracking, ["history"])
        return tracking

    # ------------------------------------------------------------ audit stamps

    @staticmethod
    def _stamp_created(
        entity: Tracking | TrackingHistory, actor: AuditActor, now: datetime
    ) -> None:
        entity.created_at = now
        entity.updated_at = now
        entity.created_by = actor.value
        entity.updated_by = actor.value

    @staticmethod
    def _stamp_updated(
        entity: Tracking | TrackingHistory, actor: AuditActor, now: datetime
    ) -> None:
        entity.updated_at = now
        entity.updated_by = actor.value
