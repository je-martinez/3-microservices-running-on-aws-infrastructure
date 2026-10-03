"""Tests for env_guard.py — dev and pre-prod never run at the same time."""

import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "env_guard.py"
sys.path.insert(0, str(SCRIPT.parent))
_spec = importlib.util.spec_from_file_location("env_guard", SCRIPT)
guard_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard_mod)


def docker_with(running_project):
    def run(*args):
        label = next(a for a in args if a.startswith("label="))
        return "abc123\n" if label.endswith(f"={running_project}") else ""
    return run


def test_proceeds_when_other_is_down():
    made = []
    rc = guard_mod.guard("preprod", run=docker_with(None), ask=lambda _: "d",
                         isatty=lambda: True, make=made.append)
    assert rc == 0 and made == []


def test_drop_tears_down_the_other_then_proceeds():
    made = []
    rc = guard_mod.guard("preprod", run=docker_with("3mrai"), ask=lambda _: "d",
                         isatty=lambda: True, make=made.append)
    assert rc == 0 and made == ["clean"]


def test_nothing_aborts():
    made = []
    rc = guard_mod.guard("dev", run=docker_with("3mrai-preprod"), ask=lambda _: "n",
                         isatty=lambda: True, make=made.append)
    assert rc == 1 and made == []


def test_no_tty_aborts_without_dropping():
    made = []
    rc = guard_mod.guard("preprod", run=docker_with("3mrai"),
                         ask=lambda _: (_ for _ in ()).throw(AssertionError("asked")),
                         isatty=lambda: False, make=made.append)
    assert rc == 1 and made == []


def test_project_match_is_exact():
    # "3mrai" must not match the "3mrai-preprod" project label.
    assert guard_mod.running("3mrai", run=docker_with("3mrai-preprod")) is False
