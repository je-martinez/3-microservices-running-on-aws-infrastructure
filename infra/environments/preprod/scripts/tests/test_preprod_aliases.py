"""Tests for preprod_aliases.py — stable Docker-network aliases for ECS tasks."""

import importlib.util
import json
import subprocess
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


def _cp(stdout="", returncode=0, stderr=""):
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


class _FakeEcs:
    def list_tasks(self, **_):
        return {"taskArns": [f"arn:aws:ecs:::task/c/{TID}"]}

    def describe_tasks(self, **_):
        return {"tasks": [{"taskArn": f"arn:aws:ecs:::task/c/{TID}", "lastStatus": "RUNNING", "startedAt": 1}]}


def test_failed_connect_is_a_failure_not_attached(monkeypatch, capsys):
    target = f"floci-ecs-{TID}-users"
    nets = {"net": {"Aliases": [], "IPAddress": "10.0.0.5"}}

    def run(*args):
        if args[0] == "ps":
            return _cp(target)
        if args[0] == "inspect":
            return _cp(json.dumps(nets))
        if args[:2] == ("network", "connect"):
            return _cp(returncode=1, stderr="Address already in use")
        return _cp()

    monkeypatch.setattr(al, "client", lambda _name: _FakeEcs())
    rc = al.main(["--cluster", "c", "--network", "net", "--aliases", "users-grpc"], run=run)
    captured = capsys.readouterr()
    assert rc == 1
    assert "Address already in use" in captured.err
    assert "attached" not in captured.out + captured.err


def test_newest_running_task_wins_over_older_running_one():
    tasks = [
        {"taskArn": "arn:x/c/old", "lastStatus": "RUNNING", "startedAt": 100},
        {"taskArn": "arn:x/c/new", "lastStatus": "RUNNING", "startedAt": 200},
        {"taskArn": "arn:x/c/dead", "lastStatus": "STOPPED", "startedAt": 300},
    ]
    assert al.newest_running(tasks) == {"new"}
    assert al.newest_running([]) == set()
