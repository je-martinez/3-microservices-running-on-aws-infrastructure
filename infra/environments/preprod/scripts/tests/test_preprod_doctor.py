"""Tests for preprod_doctor.py — pre-prod health diagnosis."""

import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "preprod_doctor.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "infra" / "scripts"))
sys.path.insert(0, str(SCRIPT.parent))
_spec = importlib.util.spec_from_file_location("preprod_doctor", SCRIPT)
pd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pd)


def test_unhealthy_targets():
    descs = [
        {"Target": {"Id": "10.0.0.1"}, "TargetHealth": {"State": "healthy"}},
        {"Target": {"Id": "10.0.0.2"}, "TargetHealth": {"State": "unhealthy"}},
        {"Target": {"Id": "10.0.0.3"}, "TargetHealth": {"State": "initial"}},
    ]
    assert pd.unhealthy_targets(descs) == ["10.0.0.2"]


def test_listener_check_skipped_when_stripe_is_off():
    called = []
    assert pd.stripe_listener_failures({}, check=lambda *a: called.append(a) or 0) == 0
    assert called == []


def test_listener_check_counts_a_down_listener():
    assert pd.stripe_listener_failures({"STRIPE_ENABLED": "true"}, check=lambda *a: 1) == 1
    assert pd.stripe_listener_failures({"STRIPE_ENABLED": "true"}, check=lambda *a: 0) == 0
