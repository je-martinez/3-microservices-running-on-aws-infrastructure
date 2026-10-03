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
        {"serviceName": "users", "runningCount": 1, "desiredCount": 1},
        {"serviceName": "orders", "runningCount": 0, "desiredCount": 1},
    ]
    assert ws.converged(services) == ["orders"]
