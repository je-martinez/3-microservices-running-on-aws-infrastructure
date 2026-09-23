"""Tests for set_stripe_webhook_secret.py.

CONTRACT: These assert the full secret NEVER appears in captured stdout or
stderr — only a masked form is allowed to reach the console.
"""

import importlib.util
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "set_stripe_webhook_secret.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "scripts"))

_spec = importlib.util.spec_from_file_location("set_stripe_webhook_secret", SCRIPT_PATH)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

SECRET = "whsec_abcdefghijklmnopqrstuvwxyz"


def _seed_env_file(path: Path) -> None:
    from lib3mrai.envfile import write_env_file

    write_env_file(
        path,
        header="Users service environment.",
        generated={"PORT_TEST": "1"},
        custom_defaults={"STRIPE_WEBHOOK_SECRET": ""},
    )


class TestSuccessPath:
    def test_writes_the_value_and_masks_console_output(
        self, tmp_path, monkeypatch, capsys
    ) -> None:
        target = tmp_path / ".env.local.users"
        _seed_env_file(target)

        monkeypatch.setattr(mod.shutil, "which", lambda _: "/usr/local/bin/stripe")
        monkeypatch.setattr(
            mod.subprocess,
            "run",
            lambda *a, **k: subprocess.CompletedProcess(
                args=a, returncode=0, stdout=f"{SECRET}\n", stderr=""
            ),
        )

        exit_code = mod.main(
            ["prog", "--repo-root", str(tmp_path), "--env-file", ".env.local.users"]
        )

        assert exit_code == 0
        from lib3mrai.envfile import read_custom_block

        assert f"STRIPE_WEBHOOK_SECRET={SECRET}" in read_custom_block(target)

        captured = capsys.readouterr()
        assert SECRET not in captured.out
        assert SECRET not in captured.err
        assert "docker compose up -d users" in captured.out

    def test_default_writes_the_same_secret_to_users_and_orders(
        self, tmp_path, monkeypatch, capsys
    ) -> None:
        users = tmp_path / ".env.local.users"
        orders = tmp_path / ".env.local.orders"
        _seed_env_file(users)
        _seed_env_file(orders)

        monkeypatch.setattr(mod.shutil, "which", lambda _: "/usr/local/bin/stripe")
        monkeypatch.setattr(
            mod.subprocess,
            "run",
            lambda *a, **k: subprocess.CompletedProcess(
                args=a, returncode=0, stdout=f"{SECRET}\n", stderr=""
            ),
        )

        exit_code = mod.main(["prog", "--repo-root", str(tmp_path)])

        assert exit_code == 0
        from lib3mrai.envfile import read_custom_block

        assert f"STRIPE_WEBHOOK_SECRET={SECRET}" in read_custom_block(users)
        assert f"STRIPE_WEBHOOK_SECRET={SECRET}" in read_custom_block(orders)

        captured = capsys.readouterr()
        assert SECRET not in captured.out
        assert SECRET not in captured.err
        assert "docker compose up -d users orders" in captured.out

    def test_mask_never_returns_the_full_secret(self) -> None:
        masked = mod.mask(SECRET)
        assert masked != SECRET
        assert SECRET not in masked


class TestCliMissing:
    def test_missing_cli_fails_with_a_login_hint(self, tmp_path, monkeypatch, capsys) -> None:
        monkeypatch.setattr(mod.shutil, "which", lambda _: None)

        exit_code = mod.main(["prog", "--repo-root", str(tmp_path)])

        assert exit_code == 1
        captured = capsys.readouterr()
        assert "stripe login" in captured.err
        assert "stripe-sandbox-setup" in captured.err


class TestGarbageOutput:
    def test_non_whsec_output_fails_without_echoing_it(
        self, tmp_path, monkeypatch, capsys
    ) -> None:
        garbage = "not-a-real-secret-at-all"
        monkeypatch.setattr(mod.shutil, "which", lambda _: "/usr/local/bin/stripe")
        monkeypatch.setattr(
            mod.subprocess,
            "run",
            lambda *a, **k: subprocess.CompletedProcess(
                args=a, returncode=0, stdout=f"{garbage}\n", stderr=""
            ),
        )

        exit_code = mod.main(["prog", "--repo-root", str(tmp_path)])

        assert exit_code == 1
        captured = capsys.readouterr()
        assert garbage not in captured.out
        assert garbage not in captured.err
        assert "stripe login" in captured.err

    def test_cli_error_fails_without_echoing_stdout(self, tmp_path, monkeypatch, capsys) -> None:
        monkeypatch.setattr(mod.shutil, "which", lambda _: "/usr/local/bin/stripe")
        monkeypatch.setattr(
            mod.subprocess,
            "run",
            lambda *a, **k: subprocess.CompletedProcess(
                args=a, returncode=1, stdout="", stderr="Error: not logged in\n"
            ),
        )

        exit_code = mod.main(["prog", "--repo-root", str(tmp_path)])

        assert exit_code == 1
        captured = capsys.readouterr()
        assert "not logged in" in captured.err
        assert "stripe login" in captured.err

    def test_timeout_fails_with_a_login_hint(self, tmp_path, monkeypatch, capsys) -> None:
        monkeypatch.setattr(mod.shutil, "which", lambda _: "/usr/local/bin/stripe")

        def _raise_timeout(*a, **k):
            raise subprocess.TimeoutExpired(cmd="stripe", timeout=30)

        monkeypatch.setattr(mod.subprocess, "run", _raise_timeout)

        exit_code = mod.main(["prog", "--repo-root", str(tmp_path)])

        assert exit_code == 1
        captured = capsys.readouterr()
        assert "stripe login" in captured.err
