#!/usr/bin/env python3
"""Run `docker compose watch` per service, each with its own rotating log.

Compose writes ONE stream for every service it watches, so a separate process
per service is what gives each its own file. Exit: 0 started/stopped, 1 error."""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG_DIR = ROOT / "logs" / "watch"
ENV_FILE = ROOT / ".env.local.web"

# CONTRACT: Every service here declares `develop.watch` in docker-compose.yml.
# `compose watch` IGNORES a service without one and still exits 0, so adding a
# name here without the compose block yields a watcher that never fires.
SERVICES = ("web", "users", "orders", "tracking")

# WHY: A rebuild logs ~40 lines, so a day of iterating reaches a few MB. Rotate
# on start rather than on a timer: the process appends for its whole lifetime,
# and truncating underneath it would confuse the writer's file offset.
MAX_BYTES = 2 * 1024 * 1024


def pid_file(service: str) -> Path:
    return LOG_DIR / f"{service}.pid"


def log_file(service: str) -> Path:
    return LOG_DIR / f"{service}.log"


def running(service: str) -> int | None:
    """The live PID for this service's watcher, or None."""
    path = pid_file(service)
    if not path.exists():
        return None
    try:
        pid = int(path.read_text().strip())
        os.kill(pid, 0)
        return pid
    except (ValueError, ProcessLookupError, PermissionError):
        path.unlink(missing_ok=True)
        return None


def rotate(path: Path) -> None:
    if path.exists() and path.stat().st_size > MAX_BYTES:
        path.replace(path.with_suffix(".log.1"))


def start(services: list[str]) -> int:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if not ENV_FILE.exists():
        print(f"ERROR: {ENV_FILE.name} is missing. Run 'make env-file' first.", file=sys.stderr)
        return 1

    for service in services:
        existing = running(service)
        if existing:
            print(f"  {service}: already watching (pid {existing})")
            continue

        rotate(log_file(service))
        # --no-up: the stack is already running; watch must not restart it.
        command = [
            "docker", "compose", "--env-file", str(ENV_FILE),
            "watch", service, "--no-up",
        ]
        with log_file(service).open("a") as handle:
            handle.write(f"\n=== watch started for {service} ===\n")
            handle.flush()
            process = subprocess.Popen(
                command, cwd=ROOT, stdout=handle, stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        pid_file(service).write_text(str(process.pid))
        print(f"  {service}: watching (pid {process.pid}) → logs/watch/{service}.log")
    return 0


def stop(services: list[str]) -> int:
    for service in services:
        pid = running(service)
        if not pid:
            print(f"  {service}: not running")
            continue
        os.killpg(os.getpgid(pid), signal.SIGTERM)
        pid_file(service).unlink(missing_ok=True)
        print(f"  {service}: stopped (pid {pid})")
    return 0


def status(services: list[str]) -> int:
    for service in services:
        pid = running(service)
        path = log_file(service)
        size = f"{path.stat().st_size // 1024} KB" if path.exists() else "no log"
        print(f"  {service}: {'watching pid ' + str(pid) if pid else 'stopped':<22} {size}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("start", "stop", "status"))
    parser.add_argument("--services", default=",".join(SERVICES))
    args = parser.parse_args()

    services = [s.strip() for s in args.services.split(",") if s.strip()]
    unknown = [s for s in services if s not in SERVICES]
    if unknown:
        print(f"ERROR: no develop.watch block for: {', '.join(unknown)}", file=sys.stderr)
        return 1

    return {"start": start, "stop": stop, "status": status}[args.action](services)


if __name__ == "__main__":
    sys.exit(main())
