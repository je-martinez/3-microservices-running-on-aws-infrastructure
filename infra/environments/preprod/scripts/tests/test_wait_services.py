"""Tests for wait_services.py — ECS convergence check."""

import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "wait_services.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "infra" / "scripts"))
_spec = importlib.util.spec_from_file_location("wait_services", SCRIPT)
ws = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ws)


def test_converged_lists_lagging_services():
    services = [
        {"serviceName": "users", "desiredCount": 1},
        {"serviceName": "orders", "desiredCount": 1},
    ]
    assert ws.converged(services, {"users": ["a"], "orders": []}) == ["orders"]


def test_overlap_of_old_and_new_task_is_not_converged():
    services = [{"serviceName": "users", "desiredCount": 1}]
    assert ws.converged(services, {"users": ["old", "new"]}) == ["users"]
    assert ws.converged(services, {"users": ["new"]}) == []


def test_pre_deploy_task_does_not_count_before_the_replacement_exists():
    svc = {"serviceName": "users", "desiredCount": 1,
           "deployments": [{"status": "PRIMARY", "createdAt": 100}]}
    old = {"taskArn": "arn:x/c/old", "lastStatus": "RUNNING", "createdAt": 50}
    new = {"taskArn": "arn:x/c/new", "lastStatus": "RUNNING", "createdAt": 120}
    assert ws.current_running([old], svc) == []
    assert ws.current_running([old, new], svc) == ["new"]
