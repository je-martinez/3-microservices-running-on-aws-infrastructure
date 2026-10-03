"""Tests for doctor's backing-container classification."""

import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

SCRIPT = Path(__file__).resolve().parents[1] / "doctor.py"
sys.path.insert(0, str(SCRIPT.parent))
_spec = importlib.util.spec_from_file_location("doctor", SCRIPT)
doctor = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(doctor)


def test_backing_state_running():
    assert doctor.backing_state("x", run=lambda *a: "Up 3 minutes\n") == "running"


def test_backing_state_exited():
    assert doctor.backing_state("x", run=lambda *a: "Exited (0) 5 seconds ago\n") == "exited"


def test_backing_state_missing():
    assert doctor.backing_state("x", run=lambda *a: "") == "missing"


def test_exited_container_remedy_is_heal():
    assert doctor.remedy_for("exited") == "make heal"


def test_missing_container_remedy_is_rebuild():
    assert doctor.remedy_for("missing") == "make clean && make bootstrap"


def test_doctor_wakes_ecs_before_checking():
    ecs = MagicMock()
    ecs.list_clusters.return_value = {"clusterArns": []}
    with patch.object(doctor, "client", return_value=ecs):
        doctor.wake_ecs_reconciler()
    ecs.list_clusters.assert_called_once()


def test_redis_ping_remedy_follows_container_state():
    assert doctor.redis_remedy("v", state_of=lambda h: "exited") == "make heal"
    assert doctor.redis_remedy("v", state_of=lambda h: "missing") == "make clean && make bootstrap"


def test_wake_ecs_failure_does_not_raise():
    ecs = MagicMock()
    ecs.list_clusters.side_effect = RuntimeError("endpoint down")
    with patch.object(doctor, "client", return_value=ecs):
        assert doctor.wake_ecs_reconciler() is False
