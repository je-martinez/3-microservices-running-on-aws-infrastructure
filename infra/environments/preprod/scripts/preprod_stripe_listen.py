#!/usr/bin/env python3
"""Run one `stripe listen` per service, forwarding pre-prod webhooks to its ALB listener.

CONTRACT: One process per service — --forward-to takes a single URL. Both run under
ONE CLI identity (`cli_env`: the `stripe login` session, or STRIPE_CLI_API_KEY), so
both carry the signing secret Terraform deployed.
WARNING: Messages show <token>, never the URL token. See [[2026-10-05-preprod-integrations-design]]
"""

from __future__ import annotations

import importlib.util
import os
import signal
import subprocess
import sys
from pathlib import Path

import preprod_integrations as pi
from lib3mrai.console import inf, no, ok

ROOT = Path(__file__).resolve().parents[4]
LOG_DIR = ROOT / "logs" / "preprod-stripe"
PORTS = {"users": 9101, "orders": 9102}
SECRET_SCRIPT = ROOT / "infra" / "environments" / "local" / "scripts" / "set_stripe_webhook_secret.py"
MAX_BYTES = 2 * 1024 * 1024


def forwards() -> dict[str, tuple[int, str]]:
    """Dev's per-service event lists — one source, so both environments subscribe alike."""
    spec = importlib.util.spec_from_file_location("set_stripe_webhook_secret", SECRET_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.FORWARDS


def command(service: str, env: dict[str, str]) -> list[str]:
    token = env[f"STRIPE_WEBHOOK_URL_TOKEN_{service.upper()}"]
    return ["stripe", "listen", "--events", forwards()[service][1],
            "--forward-to", f"http://localhost:{PORTS[service]}/v1/{service}/stripe/webhook/{token}"]


def pid_file(service: str) -> Path:
    return LOG_DIR / f"{service}.pid"


def log_file(service: str) -> Path:
    return LOG_DIR / f"{service}.log"


def is_forwarder(pid: int) -> bool:
    """WARNING: Signal a pid only when it is still one of our forwarders. A pid file
    outlives a crash or reboot, and the reused pid can be an unrelated process or the
    caller's own group — killpg on it kills make or the shell. Never print the command
    line: it carries the URL token."""
    try:
        if os.getpgid(pid) != pid or pid == os.getpgrp():
            return False
        line = subprocess.run(["ps", "-p", str(pid), "-o", "command="],
                              capture_output=True, text=True).stdout
    except (ProcessLookupError, PermissionError):
        return False
    return "stripe" in line and "listen" in line


def running(service: str) -> int | None:
    try:
        pid = int(pid_file(service).read_text().strip())
        os.kill(pid, 0)
    except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError):
        return None
    return pid if is_forwarder(pid) else None


def stop() -> int:
    for service in PORTS:
        pid = running(service)
        if pid:
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
            inf(f"{service}: stripe listen stopped (pid {pid})")
        pid_file(service).unlink(missing_ok=True)
    return 0


def start(env: dict[str, str], spawn=subprocess.Popen) -> int:
    if not pi.stripe_on(env):
        inf("Stripe is off in .env.preprod — no webhook forwarders started")
        return 0
    stop()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    child_env = pi.cli_env(env)
    for service, port in PORTS.items():
        log = log_file(service)
        if log.exists() and log.stat().st_size > MAX_BYTES:
            log.replace(log.with_suffix(".log.1"))
        with log.open("a") as handle:
            process = spawn(command(service, env), cwd=ROOT, stdout=handle, stderr=subprocess.STDOUT,
                            start_new_session=True, env=child_env)
        pid_file(service).write_text(str(process.pid))
        ok(f"{service}: forwarding → localhost:{port}/v1/{service}/stripe/webhook/<token> "
           f"(pid {process.pid}, logs/preprod-stripe/{service}.log)")
    return 0


def status() -> int:
    down = [service for service in PORTS if not running(service)]
    for service in PORTS:
        if service in down:
            no(f"{service}: stripe listen is not running - make preprod-stripe-listen")
        else:
            ok(f"{service}: stripe listen running (pid {running(service)})")
    return 1 if down else 0


def main(argv: list[str]) -> int:
    action = argv[1] if len(argv) > 1 else ""
    if action == "start":
        return start(pi.parse(pi.ENV_FILE))
    if action == "stop":
        return stop()
    if action == "status":
        return status()
    no("usage: preprod_stripe_listen.py start|stop|status")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
