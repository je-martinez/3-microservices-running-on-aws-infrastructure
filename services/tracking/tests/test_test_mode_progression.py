"""TestMode automatic progression (JE-95), against a REAL MySQL.

The design's table is the contract:

    t=0s   SHIPPED           (written by CreateTracking)
    t=10s  ON_THE_WAY
    t=20s  OUT_FOR_DELIVERY
    t=30s  DELIVERED         -> 4 history rows, in that order

## The interval is INJECTED, never slept through

Nothing here waits 30 real seconds. `run_progression` takes `interval`, and these
tests pass a value near zero, so a complete four-step run finishes in milliseconds
while production keeps the design's 10s cadence. Making the suite actually sleep
would have meant a 30-second test that a future reader deletes, or an
`@pytest.mark.skip` that hides the whole feature.

What is NOT faked: the database, the state machine, the session-per-transition, and
(in `TestEndToEndOverGrpc`) the gRPC server and the thread→loop bridge. The timing
is the only thing compressed, because it is the only thing that is purely a
duration.
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager

import pytest
from sqlalchemy.orm import Session

from src.features.tracking.commands.test_mode_progression import (
    DEFAULT_INTERVAL_SECONDS,
    advance_once,
    run_progression,
)
from src.features.tracking.domain.repository import TrackingRepository
from src.features.tracking.domain.status import TrackingStatus
from src.shared.audit.audit_actor import AuditActor

pytestmark = pytest.mark.integration

USER_ID = "usr_aaaaaaaaaaaaaaaaaaaaa"
COGNITO_SUB = "11111111-1111-4111-8111-111111111111"

#: Small enough that four steps are instant, non-zero so the loop still yields.
FAST = 0.001

#: The full expected run, including the SHIPPED row written at creation.
FULL_PROGRESSION = [
    TrackingStatus.SHIPPED,
    TrackingStatus.ON_THE_WAY,
    TrackingStatus.OUT_FOR_DELIVERY,
    TrackingStatus.DELIVERED,
]


def seed(session: Session, *, order_id: str) -> str:
    """A committed tracking at SHIPPED, as CreateTracking would leave it."""
    tracking = TrackingRepository(session).create(
        order_id=order_id,
        user_id=USER_ID,
        cognito_sub=COGNITO_SUB,
        actor=AuditActor.CREATE_TRACKING,
    )
    session.commit()
    return tracking.id


def _refresh(session: Session) -> None:
    """End this session's read snapshot so it can see OTHER sessions' commits.

    `expire_all()` alone is NOT enough, and that cost a confusing failure: it clears
    the identity map, but the session is still inside the same transaction, and
    MySQL's default REPEATABLE READ pins a consistent snapshot for its whole
    duration. Re-reading therefore returned the tracking exactly as it looked before
    the progression started — SHIPPED — while the progression's own log line said it
    had reached DELIVERED. Both were true, of different snapshots.

    This matters here and not in the other suites because the progression commits
    from a DIFFERENT session (one per transition, by design), whereas most tests
    read back through the same session that wrote.

    `rollback()` ends the transaction without discarding anything — nothing pending
    is ever written on these read paths — so the next statement opens a fresh
    snapshot.
    """
    session.rollback()
    session.expire_all()


def history_of(session: Session, order_id: str) -> list[str]:
    """The ordered statuses in the tracking's history."""
    _refresh(session)
    repo = TrackingRepository(session)
    tracking = repo.get_by_order_id(order_id)
    assert tracking is not None
    return [entry.status for entry in repo.get_history(tracking.id)]


def current_status(session: Session, order_id: str) -> str | None:
    _refresh(session)
    tracking = TrackingRepository(session).get_by_order_id(order_id)
    return None if tracking is None else tracking.status


class TestTheProductionIntervalIsTenSeconds:
    """The compressed interval used below must not become the shipped one."""

    def test_default_matches_the_design(self) -> None:
        """The design's table says 10s between transitions. The tests override it
        per call; the DEFAULT is what production actually runs."""
        assert DEFAULT_INTERVAL_SECONDS == 10.0


class TestAdvanceOnce:
    """One step, synchronous — the unit the async loop drives."""

    def test_moves_shipped_to_on_the_way(self, session: Session) -> None:
        seed(session, order_id="ord_step00000000000001")
        assert (
            advance_once(session, "ord_step00000000000001")
            == TrackingStatus.ON_THE_WAY
        )
        session.commit()
        assert current_status(session, "ord_step00000000000001") == (
            TrackingStatus.ON_THE_WAY
        )

    def test_stamps_the_test_mode_actor_not_the_carrier_one(
        self, session: Session
    ) -> None:
        """`created_by` is what makes an automatic run identifiable after the fact —
        it is the only trace that a transition was not a carrier's."""
        tracking_id = seed(session, order_id="ord_step00000000000002")
        advance_once(session, "ord_step00000000000002")
        session.commit()

        entry = next(
            e
            for e in TrackingRepository(session).get_history(tracking_id)
            if e.status == TrackingStatus.ON_THE_WAY
        )
        assert entry.created_by == AuditActor.TEST_MODE_PROGRESSION
        assert entry.created_by != AuditActor.CARRIER_STATUS_UPDATE

    def test_returns_none_at_the_terminal_status(self, session: Session) -> None:
        """None is the signal to stop, not an error. Reaching DELIVERED is how a
        run is SUPPOSED to end."""
        seed(session, order_id="ord_step00000000000003")
        for _ in range(3):
            advance_once(session, "ord_step00000000000003")
            session.commit()

        assert current_status(session, "ord_step00000000000003") == (
            TrackingStatus.DELIVERED
        )
        assert advance_once(session, "ord_step00000000000003") is None

    def test_returns_none_for_a_missing_tracking(self, session: Session) -> None:
        """Deleted between two ticks. Not an exception — there is simply nothing
        left to animate."""
        assert advance_once(session, "ord_step00000000000099") is None


class TestFullProgression:
    """The design's table, end to end."""

    @pytest.mark.anyio
    async def test_it_reaches_delivered(
        self, session: Session, session_factory
    ) -> None:
        seed(session, order_id="ord_prog00000000000001")

        await run_progression(
            "ord_prog00000000000001", interval=FAST, writer=session_factory
        )

        assert current_status(session, "ord_prog00000000000001") == (
            TrackingStatus.DELIVERED
        )

    @pytest.mark.anyio
    async def test_it_leaves_exactly_four_history_rows_in_order(
        self, session: Session, session_factory
    ) -> None:
        """"a completed TestMode run leaves 4 history entries in total" — and the
        order matters as much as the count: a shipment delivered before it shipped
        would be four rows too."""
        seed(session, order_id="ord_prog00000000000002")

        await run_progression(
            "ord_prog00000000000002", interval=FAST, writer=session_factory
        )

        assert history_of(session, "ord_prog00000000000002") == FULL_PROGRESSION

    @pytest.mark.anyio
    async def test_it_stops_at_delivered_and_writes_nothing_more(
        self, session: Session, session_factory
    ) -> None:
        """The loop must TERMINATE, not spin against a terminal tracking.

        `run_progression` returning at all is half the proof; the row count being
        unchanged afterwards is the other half. A loop that kept trying would be
        rejected by the state machine every time and hammer the database forever.
        """
        seed(session, order_id="ord_prog00000000000003")

        await run_progression(
            "ord_prog00000000000003", interval=FAST, writer=session_factory
        )
        first = history_of(session, "ord_prog00000000000003")

        # Running it again over the now-delivered tracking must be a clean no-op.
        await run_progression(
            "ord_prog00000000000003", interval=FAST, writer=session_factory
        )

        assert history_of(session, "ord_prog00000000000003") == first == (
            FULL_PROGRESSION
        )

    @pytest.mark.anyio
    async def test_each_transition_uses_its_own_session(
        self, session: Session, session_factory
    ) -> None:
        """The creating request's session is long gone by the time a real run's
        second transition fires, so each step must open its own. Counting the
        factory's invocations is what proves it — a single shared session would
        show one."""
        seed(session, order_id="ord_prog00000000000004")
        opened: list[int] = []

        def counting_writer():
            opened.append(1)
            return session_factory()

        await run_progression(
            "ord_prog00000000000004", interval=FAST, writer=counting_writer
        )

        # Three advancing steps plus the final one that finds DELIVERED and stops.
        assert len(opened) == 4


class TestMidProgressionConflicts:
    """What happens when the world changes under a sleeping task.

    Each of these ends the run CLEANLY — no exception escaping the background task,
    no infinite retry. An unretrieved exception in a fire-and-forget asyncio task
    surfaces only as a GC-time warning, which is exactly the kind of failure that
    goes unnoticed for months.
    """

    @pytest.mark.anyio
    async def test_a_carrier_delivering_first_ends_the_run_without_raising(
        self, session: Session, session_factory
    ) -> None:
        """The scenario named in the issue: something else reaches DELIVERED while
        the progression sleeps. The next step is then rejected by the state machine
        (`already_delivered`), and that rejection must END the run — not crash it,
        not retry it.
        """
        seed(session, order_id="ord_conf00000000000001")

        async def deliver_it_midway(_delay: float) -> None:
            """Stands in for the sleep, and jumps the tracking to DELIVERED on the
            first tick — before the progression's own step runs."""
            with session_factory() as other:
                tracking = TrackingRepository(other).get_by_order_id(
                    "ord_conf00000000000001"
                )
                if tracking is not None and tracking.status != (
                    TrackingStatus.DELIVERED
                ):
                    TrackingRepository(other).update_status(
                        tracking=tracking,
                        status=TrackingStatus.DELIVERED,
                        actor=AuditActor.CARRIER_STATUS_UPDATE,
                    )

        # No pytest.raises: the whole point is that nothing propagates.
        await run_progression(
            "ord_conf00000000000001",
            interval=FAST,
            writer=session_factory,
            sleep=deliver_it_midway,
        )

        assert current_status(session, "ord_conf00000000000001") == (
            TrackingStatus.DELIVERED
        )
        # The carrier's DELIVERED landed; the progression added no ON_THE_WAY after
        # it and did not loop.
        assert history_of(session, "ord_conf00000000000001") == [
            TrackingStatus.SHIPPED,
            TrackingStatus.DELIVERED,
        ]

    @pytest.mark.anyio
    async def test_an_invalid_transition_does_not_retry_forever(
        self, session: Session, session_factory
    ) -> None:
        """A rejected transition is terminal for the run.

        Retrying a forward-only rejection can only be rejected again — the guard is
        deterministic. Bounding the sleep count proves the loop exits rather than
        spinning: an infinite retry would blow past the cap and hang the test.
        """
        seed(session, order_id="ord_conf00000000000002")
        ticks = 0

        async def deliver_then_count(_delay: float) -> None:
            nonlocal ticks
            ticks += 1
            assert ticks < 10, "progression retried a rejected transition"
            if ticks == 1:
                with session_factory() as other:
                    tracking = TrackingRepository(other).get_by_order_id(
                        "ord_conf00000000000002"
                    )
                    TrackingRepository(other).update_status(
                        tracking=tracking,
                        status=TrackingStatus.DELIVERED,
                        actor=AuditActor.CARRIER_STATUS_UPDATE,
                    )

        await run_progression(
            "ord_conf00000000000002",
            interval=FAST,
            writer=session_factory,
            sleep=deliver_then_count,
        )

        assert ticks < 10

    @pytest.mark.anyio
    async def test_a_deleted_tracking_ends_the_run_without_raising(
        self, session: Session, session_factory
    ) -> None:
        """Soft-deleted mid-run. The repository's reads exclude it, so the next step
        finds nothing — which stops the run instead of raising."""
        tracking_id = seed(session, order_id="ord_conf00000000000003")

        async def delete_it(_delay: float) -> None:
            with session_factory() as other:
                tracking = TrackingRepository(other).get_by_order_id(
                    "ord_conf00000000000003"
                )
                if tracking is not None:
                    tracking.deleted_at = tracking.created_at
                    tracking.deleted_by = AuditActor.CARRIER_STATUS_UPDATE.value

        await run_progression(
            "ord_conf00000000000003",
            interval=FAST,
            writer=session_factory,
            sleep=delete_it,
        )

        # Still only the creation row — nothing was appended after the delete.
        assert [
            entry.status
            for entry in TrackingRepository(session).get_history(tracking_id)
        ] == [TrackingStatus.SHIPPED]

    @pytest.mark.anyio
    async def test_an_unexpected_error_is_swallowed_and_logged(
        self, session: Session, session_factory, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A background task must never die silently OR loudly.

        Anything unexpected is logged as a `*_failed` event with a `reason` (per
        [[logging-context]]) and the run ends. Letting it propagate would produce
        only a GC-time "Task exception was never retrieved" warning.
        """
        seed(session, order_id="ord_conf00000000000004")

        async def explode(_delay: float) -> None:
            raise RuntimeError("something unforeseen")

        with caplog.at_level("ERROR"):
            await run_progression(
                "ord_conf00000000000004",
                interval=FAST,
                writer=session_factory,
                sleep=explode,
            )

        assert any(
            record.__dict__.get("app_event") == "test_mode_progression_failed"
            and record.__dict__.get("reason") == "unexpected_error"
            for record in caplog.records
        )

    @pytest.mark.anyio
    async def test_cancellation_propagates_so_shutdown_still_works(
        self, session: Session, session_factory
    ) -> None:
        """`CancelledError` must NOT be swallowed by the catch-all.

        If it were, the event loop could not cancel this task at shutdown and would
        hang waiting for a 30-second fixture to finish.
        """
        seed(session, order_id="ord_conf00000000000005")

        task = asyncio.ensure_future(
            run_progression(
                "ord_conf00000000000005", interval=5.0, writer=session_factory
            )
        )
        # Let it reach the sleep, then cancel.
        await asyncio.sleep(0)
        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await task

        # The documented limitation, observed: the tracking stays where it was.
        assert current_status(session, "ord_conf00000000000005") == (
            TrackingStatus.SHIPPED
        )


class TestTheSyncToAsyncBridge:
    """The crux of JE-95: a SYNC gRPC thread starting an ASYNC progression.

    `CreateTracking` runs on a `grpc.server` thread pool (Phase C chose threads
    because pymysql blocks). That thread has no event loop, so `create_task` raises
    and `asyncio.run` would block the RPC for 30 seconds. The bridge is
    `run_coroutine_threadsafe` onto uvicorn's loop, registered by the FastAPI
    lifespan.

    These tests exercise the seam ACROSS A REAL THREAD, because that is the only
    place the bug can live — calling `spawn` from the test's own coroutine would
    prove nothing about the thread it actually runs on.
    """

    @pytest.mark.anyio
    async def test_a_worker_thread_can_start_work_on_the_registered_loop(
        self, session: Session, session_factory
    ) -> None:
        """The whole mechanism, minus gRPC: register the loop, call `spawn` from
        another thread, and watch the tracking advance on the loop."""
        from src.shared.scheduling import background

        seed(session, order_id="ord_brdg00000000000001")
        done = asyncio.Event()

        async def progress_then_signal() -> None:
            await run_progression(
                "ord_brdg00000000000001", interval=FAST, writer=session_factory
            )
            done.set()

        background.set_event_loop(asyncio.get_running_loop())
        try:
            # The call happens on a WORKER THREAD, exactly like a gRPC handler.
            scheduled = await asyncio.to_thread(
                background.spawn,
                progress_then_signal(),
                app_event="test_mode_progression",
            )
            assert scheduled is True
            await asyncio.wait_for(done.wait(), timeout=10)
        finally:
            background.set_event_loop(None)

        assert history_of(session, "ord_brdg00000000000001") == FULL_PROGRESSION

    def test_spawn_without_a_loop_is_a_no_op_not_a_crash(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The standalone gRPC entrypoint and unit tests have no FastAPI loop.

        Creation must still succeed there — a tracking failing to be created
        because a TEST fixture could not be started would be far worse than the
        fixture not running.
        """
        from src.shared.scheduling import background

        async def never_runs() -> None:  # pragma: no cover - must not execute
            raise AssertionError("scheduled despite there being no loop")

        background.set_event_loop(None)
        with caplog.at_level("INFO"):
            assert (
                background.spawn(never_runs(), app_event="test_mode_progression")
                is False
            )

        assert any(
            record.__dict__.get("app_event") == "test_mode_progression_failed"
            and record.__dict__.get("reason") == "no_event_loop"
            for record in caplog.records
        )

    def test_the_lifespan_registers_and_clears_the_loop(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Startup must publish the loop, and shutdown must retract it.

        A stale loop left registered after shutdown means a late RPC submitting
        work to a closed loop.
        """
        from fastapi.testclient import TestClient

        from src.main import GRPC_ENABLED_ENV, create_app
        from src.shared.scheduling import background

        monkeypatch.setenv(GRPC_ENABLED_ENV, "0")
        background.set_event_loop(None)

        with TestClient(create_app()) as client:
            assert client.get("/v1/health").status_code == 200
            # Registered while the app is up — the gRPC thread's target.
            assert background.get_event_loop() is not None

        assert background.get_event_loop() is None


class TestEndToEndOverGrpc:
    """`CreateTracking(test_mode=True)` over a REAL gRPC server and socket.

    The only test that covers the whole feature as Orders will actually trigger it:
    a real RPC, on a real thread pool, bridging to a real event loop, writing to a
    real MySQL. Everything except the 10-second cadence.
    """

    @pytest.fixture
    def servicer_port(self, engine, session_factory):
        """A gRPC server whose progression interval is compressed to ~0."""
        from src.features.tracking.grpc.service import TrackingServicer
        from src.shared.grpc.server import build_server
        from tests.conftest import TEST_API_KEY

        @contextmanager
        def read_session():
            with session_factory() as s:
                yield s

        server = build_server(
            api_key=TEST_API_KEY,
            servicer=TrackingServicer(
                writer=session_factory,
                reader=read_session,
                progression_interval=FAST,
                progression_writer=session_factory,
            ),
        )
        port = server.add_insecure_port("127.0.0.1:0")
        server.start()
        try:
            yield port
        finally:
            server.stop(None).wait()

    @pytest.mark.anyio
    async def test_test_mode_true_drives_the_tracking_to_delivered(
        self, session: Session, servicer_port: int
    ) -> None:
        import grpc

        from src.shared.grpc.generated import tracking_pb2, tracking_pb2_grpc
        from src.shared.scheduling import background

        background.set_event_loop(asyncio.get_running_loop())
        try:
            with grpc.insecure_channel(f"127.0.0.1:{servicer_port}") as channel:
                stub = tracking_pb2_grpc.TrackingStub(channel)
                # The RPC must RETURN promptly — it schedules, it does not wait for
                # the shipment to be "delivered".
                response = await asyncio.to_thread(
                    stub.CreateTracking,
                    tracking_pb2.CreateTrackingRequest(
                        order_id="ord_e2e000000000000001",
                        user_id=USER_ID,
                        cognito_sub=COGNITO_SUB,
                        test_mode=True,
                    ),
                    metadata=[("x-api-key", "test-grpc-api-key")],
                )
                assert response.tracking.status == TrackingStatus.SHIPPED

                await _wait_for_delivered(session, "ord_e2e000000000000001")
        finally:
            background.set_event_loop(None)

        assert history_of(session, "ord_e2e000000000000001") == FULL_PROGRESSION

    @pytest.mark.anyio
    async def test_test_mode_false_schedules_nothing(
        self, session: Session, servicer_port: int
    ) -> None:
        """"When TestMode is false or absent, no automatic progression happens."" """
        import grpc

        from src.shared.grpc.generated import tracking_pb2, tracking_pb2_grpc
        from src.shared.scheduling import background

        background.set_event_loop(asyncio.get_running_loop())
        try:
            with grpc.insecure_channel(f"127.0.0.1:{servicer_port}") as channel:
                stub = tracking_pb2_grpc.TrackingStub(channel)
                await asyncio.to_thread(
                    stub.CreateTracking,
                    tracking_pb2.CreateTrackingRequest(
                        order_id="ord_e2e000000000000002",
                        user_id=USER_ID,
                        test_mode=False,
                    ),
                    metadata=[("x-api-key", "test-grpc-api-key")],
                )
                # Give a scheduled-but-unwanted progression ample time to misfire.
                await asyncio.sleep(0.2)
        finally:
            background.set_event_loop(None)

        assert current_status(session, "ord_e2e000000000000002") == (
            TrackingStatus.SHIPPED
        )
        assert history_of(session, "ord_e2e000000000000002") == [
            TrackingStatus.SHIPPED
        ]

    @pytest.mark.anyio
    async def test_the_automatic_transitions_are_attributed_to_test_mode(
        self, session: Session, servicer_port: int
    ) -> None:
        """A completed run is identifiable from `tracking_history.created_by` alone
        — the audit trail is where "how did this row come to exist" belongs."""
        import grpc

        from src.shared.grpc.generated import tracking_pb2, tracking_pb2_grpc
        from src.shared.scheduling import background

        background.set_event_loop(asyncio.get_running_loop())
        try:
            with grpc.insecure_channel(f"127.0.0.1:{servicer_port}") as channel:
                stub = tracking_pb2_grpc.TrackingStub(channel)
                response = await asyncio.to_thread(
                    stub.CreateTracking,
                    tracking_pb2.CreateTrackingRequest(
                        order_id="ord_e2e000000000000003",
                        user_id=USER_ID,
                        test_mode=True,
                    ),
                    metadata=[("x-api-key", "test-grpc-api-key")],
                )
                await _wait_for_delivered(session, "ord_e2e000000000000003")
        finally:
            background.set_event_loop(None)

        _refresh(session)
        actors = {
            entry.status: entry.created_by
            for entry in TrackingRepository(session).get_history(
                response.tracking.id
            )
        }
        assert actors[TrackingStatus.SHIPPED] == AuditActor.CREATE_TRACKING
        for status in (
            TrackingStatus.ON_THE_WAY,
            TrackingStatus.OUT_FOR_DELIVERY,
            TrackingStatus.DELIVERED,
        ):
            assert actors[status] == AuditActor.TEST_MODE_PROGRESSION


async def _wait_for_delivered(
    session: Session, order_id: str, *, timeout: float = 10.0
) -> None:
    """Poll until the tracking reaches DELIVERED, or fail with what it reached.

    Polling rather than a fixed sleep: the progression runs on the loop and its
    steps hop to worker threads, so the completion time is not a number this test
    can know. A fixed sleep would be either flaky or needlessly slow.
    """
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if current_status(session, order_id) == TrackingStatus.DELIVERED:
            return
        await asyncio.sleep(0.02)
    raise AssertionError(
        f"{order_id} never reached DELIVERED; stuck at "
        f"{current_status(session, order_id)}"
    )
