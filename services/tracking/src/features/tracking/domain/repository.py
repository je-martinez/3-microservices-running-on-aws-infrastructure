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
`DELETE` — deletion is stamping the audit columns, which is what
`soft_delete_by_tag` (the E2E cleanup's write path) does.
"""

from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import Select, func, or_, select, update
from sqlalchemy.orm import Session

from src.features.tracking.domain.models import Tracking, TrackingHistory
from src.features.tracking.domain.status import INITIAL_STATUS, TrackingStatus
from src.shared.audit.audit_actor import AuditActor
from src.shared.db.nano_id import new_tracking_id
from src.shared.db.tracking_number import new_tracking_number


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
        tags: list[str] | None = None,
        status: TrackingStatus = INITIAL_STATUS,
        actor: AuditActor = AuditActor.CREATE_TRACKING,
        now: datetime | None = None,
    ) -> Tracking:
        """Create a tracking and its first history entry, in one unit of work.

        A tracking is never created without the matching history row: the record's
        initial status IS a transition, and the design's TestMode table counts it
        as one of the five entries a completed run leaves behind. Emitting both
        here makes that impossible to forget at a call site.

        Does NOT commit — the caller's `write_session` owns the transaction
        boundary, so creation and any follow-up work commit or roll back together.

        `cognito_sub` defaults to None so a caller that does not know it can still
        create — the wire field is optional (see the .proto). The resulting row is
        unreachable over the user-scoped REST reads and fully readable over gRPC.

        `tags` defaults to the empty list, NOT None: the column is NOT NULL and
        "no tags" has exactly one spelling (see `Tracking.tags`). A caller that
        does not care about tags — which is every caller except the E2E creation
        path — writes `[]` by simply not passing it.

        ## The tracking number is minted here, and is not a parameter

        `tracking_number` is generated below rather than accepted, for the same
        reason `id` is: it is the row's own identity, not an input to creating
        one. Making it a parameter would let a caller supply a duplicate (or an
        empty string) into a NOT NULL UNIQUE column, and would mean every write
        path had to remember to mint one. There is exactly one creation path in
        this service, and this is it — so minting here makes "every tracking has
        a number" true by construction rather than by convention.
        """
        moment = now or _utcnow()
        tracking = Tracking(
            id=new_tracking_id(),
            order_id=order_id,
            # OURS, not a carrier's: this row exists from PLACED, before any
            # shipper is involved. See `shared/db/tracking_number.py`.
            tracking_number=new_tracking_number(),
            user_id=user_id,
            cognito_sub=cognito_sub,
            status=status.value,
            shipping_address=shipping_address,
            # `list(...)` so the row does not alias a list the caller still holds
            # and may mutate after this returns.
            tags=list(tags) if tags else [],
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

    @staticmethod
    def _has_tag(tag: str):
        """The predicate for "this row's `tags` array contains `tag`".

        `JSON_CONTAINS(tags, JSON_QUOTE(:tag))` — MySQL's array-membership test,
        since MySQL has no array type and `tags` is a JSON array (see
        `Tracking.tags`). Verified against the real server, MySQL 8.0.46: it
        matches `["E2E Source"]` and `["x", "E2E Source"]`, and does not match
        `[]` or `["other"]`.

        `JSON_QUOTE` rather than interpolating `'"E2E Source"'` into the SQL. The
        second argument of `JSON_CONTAINS` must be valid JSON, so a bare `:tag`
        bind fails with "Invalid JSON text" — the wrapping is not optional. Doing
        it in SQL keeps the value a **bound parameter**: building the JSON string
        in Python and substituting it would put caller-supplied text into the
        statement, which is a place a quote character does not belong.
        """
        return func.json_contains(Tracking.tags, func.json_quote(tag))

    def soft_delete_by_tag(
        self,
        tag: str,
        *,
        actor: AuditActor,
        now: datetime | None = None,
    ) -> int:
        """Soft-delete every live tracking tagged `tag`, and its history.

        Returns the number of `tracking` rows stamped (history rows are not
        counted; there is one per transition and the caller has no use for that
        number).

        ## Why the tag, and not the caller

        This is the E2E teardown's delete, and the teardown runs globally with no
        user session — no `x-user-id`, so nothing to scope to. Scoping by
        `cognito_sub` (which this method used to do) made the endpoint unusable by
        its only caller. Tagging at creation moves the decision to the one moment
        an identity is actually present, and leaves this a single unscoped
        predicate. Users' cleanup is the same shape.

        The safety property that scoping used to provide is not lost, it moved:
        only a request carrying `x-e2e-source` **while `E2E_TESTING_ENABLED` is
        on** is ever tagged (`shared/http/e2e_source.py`), and this route is only
        mounted under that same flag. An untagged row — which is every row any real
        user ever created — is untouchable through here.

        ## Never a SQL DELETE

        Stamps `deleted_at` / `deleted_by` and nothing else — the rows stay in the
        table, and every read already excludes them through `_live()`. This is the
        [[soft-delete]] rule, and here it is not merely a convention to honor: the
        application database user is granted no `DELETE` privilege, so a hard
        delete would fail at the server anyway.

        ## Why the history is stamped too, and how it is selected

        `tracking_history` carries its own `deleted_at`, and `get_history` filters
        on it. Leaving the children live would make a tracking's transitions
        readable after the tracking itself is gone — an orphaned trail whose parent
        no read can reach.

        The children are selected **through the FK**, by a subquery over the tagged
        parents, not by a `tags` column of their own — `tracking_history` has none,
        deliberately (see its class docstring). That is what keeps the tag single
        sourced: a history row is an E2E fixture exactly when its tracking is, with
        no second copy of the fact to drift.

        Both statements are bulk `UPDATE`s issued through the ORM rather than a
        load-then-mutate loop: a cleanup can span an arbitrary number of rows, and
        loading them all to stamp two columns each would be N+1 in the worst place.
        `synchronize_session=False` because nothing in this session goes on to use
        the affected entities — the caller's next action is to return the count.
        """
        moment = now or _utcnow()
        stamp = {"deleted_at": moment, "deleted_by": actor.value}

        # The tagged parents. Note it is NOT filtered on `deleted_at IS NULL`: an
        # already-soft-deleted tracking may still have live history under it (a
        # partial previous run), and those children should still be swept. The
        # per-statement `deleted_at IS NULL` guards below are what keep the stamps
        # idempotent.
        tagged_ids = select(Tracking.id).where(self._has_tag(tag))

        # Children first, mirroring the FK direction, so an interrupted unit of
        # work can never leave a live history row under a deleted tracking.
        self.session.execute(
            update(TrackingHistory)
            .where(
                TrackingHistory.tracking_id.in_(tagged_ids),
                TrackingHistory.deleted_at.is_(None),
            )
            .values(**stamp)
            .execution_options(synchronize_session=False)
        )
        result = self.session.execute(
            update(Tracking)
            .where(
                self._has_tag(tag),
                Tracking.deleted_at.is_(None),
            )
            .values(**stamp)
            .execution_options(synchronize_session=False)
        )
        return int(result.rowcount or 0)

    def soft_delete_by_user(
        self,
        *,
        cognito_sub: str,
        user_id: str,
        actor: AuditActor,
        now: datetime | None = None,
    ) -> int:
        """Soft-delete every live tracking belonging to a user, and its history.

        Returns the number of `tracking` rows stamped (history rows are not counted;
        the caller has no use for that number).

        ## Why the predicate matches EITHER identity

        `cognito_sub` is the ownership key every user-scoped read filters by, and it
        is what the caller naturally has in hand. But the column is NULLABLE on rows
        created before migration `b17f4c2e9a30`, and those rows still carry
        `user_id`. Matching only `cognito_sub` would silently leave a returning
        user's oldest trackings live and unreachable — the exact failure this
        service's own column docstring warns about. So both are matched, and Users
        sends both.

        This reintroduces the caller scoping `soft_delete_by_tag` deliberately gave
        up: that method serves the global E2E teardown, which runs with no session
        and therefore no identity. Here an identity IS present, which is the whole
        point of the operation.

        ## Never a SQL DELETE

        Stamps `deleted_at` / `deleted_by` only ([[soft-delete]]). The application
        database user is granted no `DELETE` privilege, so a hard delete would fail
        at the server anyway.
        """
        moment = now or _utcnow()
        stamp = {"deleted_at": moment, "deleted_by": actor.value}
        # Refused HERE as well as at the schema, because this is the line that
        # actually decides which rows die. The predicate is an OR, so an empty
        # identity on either side would match every row carrying an empty string in
        # that column — someone else's trackings. The route's Pydantic model
        # already rejects empties (422), but this method is public and a future
        # caller reaching it another way must not be able to widen the blast
        # radius by passing "".
        if not cognito_sub or not user_id:
            raise ValueError(
                "soft_delete_by_user requires both identities to be non-empty"
            )

        # `collate("utf8mb4_bin")` is a SAFETY control, not a tuning knob.
        #
        # Both columns are `utf8mb4_unicode_ci` — case-INSENSITIVE — while the ids
        # they hold come from a MIXED-CASE alphabet (`A-Za-z0-9`, see [[nano-id]])
        # minted by Users' Postgres, which compares case-SENSITIVELY. So Postgres
        # can legitimately issue `usr_AbC…` and `usr_abc…` as two different people
        # that MySQL cannot tell apart, and an erasure keyed on one would sweep the
        # other's trackings. Verified against the live database on 2026-08-26: an id
        # with its case inverted matched a real row.
        #
        # Pinned at the PREDICATE rather than fixed in the schema because that keeps
        # the change scoped to the irreversible operation. The user-scoped READS
        # share the same root cause and are deliberately left alone here — a read
        # returning a neighbour's row is a bug, but a delete removing it is not
        # recoverable without hand-written SQL.
        owned = or_(
            Tracking.cognito_sub.collate("utf8mb4_bin") == cognito_sub,
            Tracking.user_id.collate("utf8mb4_bin") == user_id,
        )

        # NOT filtered on `deleted_at IS NULL`: an already-soft-deleted tracking may
        # still have live history under it from a partial previous run, and those
        # children should still be swept. The per-statement guards below keep the
        # stamps idempotent.
        owned_ids = select(Tracking.id).where(owned)

        # Children first, mirroring the FK direction, so an interrupted unit of work
        # can never leave a live history row under a deleted tracking.
        self.session.execute(
            update(TrackingHistory)
            .where(
                TrackingHistory.tracking_id.in_(owned_ids),
                TrackingHistory.deleted_at.is_(None),
            )
            .values(**stamp)
            .execution_options(synchronize_session=False)
        )
        result = self.session.execute(
            update(Tracking)
            .where(owned, Tracking.deleted_at.is_(None))
            .values(**stamp)
            .execution_options(synchronize_session=False)
        )
        return int(result.rowcount or 0)

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
