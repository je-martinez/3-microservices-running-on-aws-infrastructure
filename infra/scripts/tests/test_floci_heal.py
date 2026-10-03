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
        return next((out for label, out in by_label.items() if label in args), "")

    assert heal.exited_backing_containers(fake_docker) == [
        "floci-docdb-db-x",
        "floci-valkey-cache-y",
    ]
    assert all("status=exited" in call for call in calls)
    assert not any(a in ("rm", "create", "run") for call in calls for a in call)
