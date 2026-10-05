"""Tests for preprod_stripe_listen.py."""

import importlib.util
import os
import stat
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "preprod_stripe_listen.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "infra" / "scripts"))
sys.path.insert(0, str(SCRIPT.parent))
_spec = importlib.util.spec_from_file_location("preprod_stripe_listen", SCRIPT)
sl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sl)

ON = {"STRIPE_ENABLED": "true", "STRIPE_SECRET_KEY_USERS": "rk_test_USERKEY",
      "STRIPE_WEBHOOK_URL_TOKEN_USERS": "TOKU", "STRIPE_WEBHOOK_URL_TOKEN_ORDERS": "TOKO"}
WITH_CLI_KEY = {**ON, "STRIPE_CLI_API_KEY": "sk_test_CLIKEY"}


class FakeProcess:
    # WARNING: a live pid so `running()` sees it — it is pytest's own. Never let a test
    # call the real `stop()` with these pid files, or it SIGTERMs the test run.
    pid = os.getpid()


def test_command_forwards_to_the_alb_listener_with_dev_events():
    cmd = sl.command("users", ON)
    assert cmd[:2] == ["stripe", "listen"]
    assert cmd[cmd.index("--events") + 1] == sl.forwards()["users"][1]
    assert cmd[cmd.index("--forward-to") + 1] == "http://localhost:9101/v1/users/stripe/webhook/TOKU"
    assert sl.command("orders", ON)[-1] == "http://localhost:9102/v1/orders/stripe/webhook/TOKO"


def test_no_key_ever_goes_in_argv():
    for part in sl.command("users", WITH_CLI_KEY):
        assert "rk_test_USERKEY" not in part and "sk_test_CLIKEY" not in part


def test_start_is_a_no_op_when_stripe_is_off(tmp_path, monkeypatch):
    monkeypatch.setattr(sl, "LOG_DIR", tmp_path)
    spawned = []
    assert sl.start({}, spawn=lambda *a, **k: spawned.append(a)) == 0
    assert spawned == []


def test_start_uses_the_login_session_unless_a_cli_key_is_set(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(sl, "LOG_DIR", tmp_path)
    monkeypatch.setattr(sl, "stop", lambda: 0)  # pid files hold pytest's own pid — see FakeProcess
    monkeypatch.delenv("STRIPE_API_KEY", raising=False)
    seen = []

    def spawn(cmd, **kwargs):
        seen.append(kwargs["env"].get("STRIPE_API_KEY"))
        return FakeProcess()

    assert sl.start(ON, spawn=spawn) == 0
    assert seen == [None, None]
    out = capsys.readouterr().out
    assert "TOKU" not in out and "TOKO" not in out and "<token>" in out
    assert (tmp_path / "users.pid").exists() and (tmp_path / "orders.pid").exists()

    seen.clear()
    assert sl.start(WITH_CLI_KEY, spawn=spawn) == 0
    assert seen == ["sk_test_CLIKEY", "sk_test_CLIKEY"]


def test_start_replaces_running_listeners(tmp_path, monkeypatch):
    monkeypatch.setattr(sl, "LOG_DIR", tmp_path)
    stopped = []
    monkeypatch.setattr(sl, "stop", lambda: stopped.append(True) or 0)
    sl.start(ON, spawn=lambda cmd, **k: FakeProcess())
    assert stopped == [True]


def test_stop_without_listeners_succeeds(tmp_path, monkeypatch):
    monkeypatch.setattr(sl, "LOG_DIR", tmp_path)
    assert sl.stop() == 0


def test_status_fails_when_a_listener_is_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(sl, "LOG_DIR", tmp_path)
    monkeypatch.setattr(sl, "is_forwarder", lambda pid: True)
    (tmp_path / "users.pid").write_text(str(os.getpid()))
    assert sl.status() == 1
    (tmp_path / "orders.pid").write_text(str(os.getpid()))
    assert sl.status() == 0


def test_a_live_non_forwarder_pid_is_never_signalled(tmp_path, monkeypatch):
    monkeypatch.setattr(sl, "LOG_DIR", tmp_path)
    calls = []
    monkeypatch.setattr(sl.os, "killpg", lambda *a: calls.append(a))
    for service in sl.PORTS:
        (tmp_path / f"{service}.pid").write_text(str(os.getpid()))  # real identity check: pytest
    assert sl.running("users") is None
    assert sl.status() == 1
    assert sl.stop() == 0
    assert calls == []
    assert not (tmp_path / "users.pid").exists() and not (tmp_path / "orders.pid").exists()


def test_stop_signals_a_confirmed_forwarder(tmp_path, monkeypatch):
    monkeypatch.setattr(sl, "LOG_DIR", tmp_path)
    monkeypatch.setattr(sl, "is_forwarder", lambda pid: True)
    calls = []
    monkeypatch.setattr(sl.os, "killpg", lambda *a: calls.append(a))
    (tmp_path / "users.pid").write_text(str(os.getpid()))
    assert sl.stop() == 0
    assert len(calls) == 1
    assert not (tmp_path / "users.pid").exists()


def _mode(path):
    return stat.S_IMODE(path.stat().st_mode)


def test_start_keeps_logs_and_pid_files_private(tmp_path, monkeypatch):
    log_dir = tmp_path / "sub"
    monkeypatch.setattr(sl, "LOG_DIR", log_dir)
    monkeypatch.setattr(sl, "stop", lambda: 0)  # pid files hold pytest's own pid — see FakeProcess
    sl.start(ON, spawn=lambda cmd, **k: FakeProcess())
    assert _mode(log_dir) == 0o700
    for service in sl.PORTS:
        assert _mode(log_dir / f"{service}.log") == 0o600
        assert _mode(log_dir / f"{service}.pid") == 0o600


def test_start_tightens_a_pre_existing_world_readable_dir_and_log(tmp_path, monkeypatch):
    log_dir = tmp_path / "sub"
    log_dir.mkdir(mode=0o755)
    os.chmod(log_dir, 0o755)
    (log_dir / "users.log").write_text("old")
    os.chmod(log_dir / "users.log", 0o644)
    monkeypatch.setattr(sl, "LOG_DIR", log_dir)
    monkeypatch.setattr(sl, "stop", lambda: 0)
    sl.start(ON, spawn=lambda cmd, **k: FakeProcess())
    assert _mode(log_dir) == 0o700
    assert _mode(log_dir / "users.log") == 0o600
