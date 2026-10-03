"""Tests for floci_heal.py — recovery after a Floci or Docker restart."""

import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock

SCRIPT = Path(__file__).resolve().parents[1] / "floci_heal.py"
sys.path.insert(0, str(SCRIPT.parent))
_spec = importlib.util.spec_from_file_location("floci_heal", SCRIPT)
heal = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(heal)


def test_wake_ecs_lists_clusters():
    ecs = MagicMock()
    ecs.list_clusters.return_value = {"clusterArns": ["arn:c1"]}
    assert heal.wake_ecs(ecs) == ["arn:c1"]
    ecs.list_clusters.assert_called_once()


def test_live_task_ids_strips_arn_prefix():
    ecs = MagicMock()
    ecs.list_tasks.return_value = {
        "taskArns": ["arn:aws:ecs:us-east-1:000000000000:task/c1/abc123"]
    }
    assert heal.live_task_ids(ecs, ["arn:c1"]) == {"abc123"}


def test_removes_only_orphan_task_containers():
    names = [
        "floci-ecs-abc123-nginx",
        "floci-ecs-dead99-nginx",
        "floci-docdb-db-x",
    ]
    assert heal.orphan_task_containers(names, {"abc123"}) == ["floci-ecs-dead99-nginx"]


def test_starts_exited_backing_containers_without_recreating():
    calls = []

    by_label = {
        "label=io.floci.service=docdb": "floci-docdb-db-x\n",
        "label=io.floci.service=elasticache": "floci-valkey-cache-y\n",
    }

    def fake_docker(*args):
        calls.append(args)
        if "status=exited" not in args:
            return ""
        return next((out for label, out in by_label.items() if label in args), "")

    assert heal.exited_backing_containers(fake_docker) == [
        "floci-docdb-db-x",
        "floci-valkey-cache-y",
    ]
    assert {a for call in calls for a in call if a.startswith("status=")} == {
        "status=exited",
        "status=created",
    }
    assert not any(a in ("rm", "create", "run") for call in calls for a in call)


def test_exited_backing_covers_created_status():
    seen = []

    def fake_docker(*args):
        seen.append(args)
        return "floci-valkey-c\n" if "status=created" in args and "label=io.floci.service=elasticache" in args else ""

    assert heal.exited_backing_containers(fake_docker) == ["floci-valkey-c"]


def test_main_returns_1_without_calling_ecs_when_floci_is_down(monkeypatch):
    client = MagicMock()
    monkeypatch.setattr(heal, "floci_answers", lambda *a, **k: False)
    monkeypatch.setattr(heal, "client", client)
    assert heal.main([]) == 1
    client.assert_not_called()


def test_main_returns_1_when_ecs_raises(monkeypatch):
    ecs = MagicMock()
    ecs.list_clusters.side_effect = RuntimeError("EndpointConnectionError")
    monkeypatch.setattr(heal, "floci_answers", lambda *a, **k: True)
    monkeypatch.setattr(heal, "client", lambda name: ecs)
    assert heal.main([]) == 1


def test_orphan_listing_is_scoped_to_the_stack_network(monkeypatch):
    ecs = MagicMock()
    ecs.list_clusters.return_value = {"clusterArns": []}
    calls = []
    monkeypatch.setattr(heal, "floci_answers", lambda *a, **k: True)
    monkeypatch.setattr(heal, "client", lambda name: ecs)
    monkeypatch.setattr(heal, "docker", lambda *a: calls.append(a) or "")
    monkeypatch.setattr(heal, "exited_backing_containers", lambda *a: [])
    monkeypatch.delenv("FLOCI_NETWORK", raising=False)
    assert heal.main([]) == 0
    assert ("ps", "--filter", "network=3mrai_3mrai-network", "--format", "{{.Names}}") in calls
