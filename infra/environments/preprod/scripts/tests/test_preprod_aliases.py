"""Tests for preprod_aliases.py — stable Docker-network aliases for ECS tasks."""

import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "preprod_aliases.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "infra" / "scripts"))
_spec = importlib.util.spec_from_file_location("preprod_aliases", SCRIPT)
al = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(al)

TID = "0" * 32


def test_container_for_picks_the_live_task():
    names = [f"floci-ecs-{TID}-mailpit", f"floci-ecs-{'1' * 32}-mailpit"]
    assert al.container_for({TID}, names, "mailpit") == f"floci-ecs-{TID}-mailpit"


def test_container_for_none_when_absent():
    assert al.container_for({TID}, [], "mailpit") is None


def test_alias_missing_is_reported():
    assert al.missing_aliases({"mailpit": []}, ["mailpit"]) == ["mailpit"]
    assert al.missing_aliases({"mailpit": ["mailpit"]}, ["mailpit"]) == []
