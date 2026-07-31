#!/usr/bin/env python3
"""Report which state the local stack is actually in.

WHY THIS EXISTS
---------------
`make bootstrap` is a twelve-step chain, and when it dies partway there was no
way to ask "what got done?" — you inferred it from whatever broke later, which
is how a real session spent its time chasing a 502 at the gateway and a 500 from
Tracking before finding the actual causes: an unattached nginx alias and missing
Alembic migrations, both simply steps that never ran (JE-112).

The blind spot this exists for above all others: **a database can exist while
its tables do not**. Phase-1 terraform creates the `tracking` database;
`make migrate-tracking`, much later in the chain, creates its tables. Everything
downstream reports healthy — the container starts, /v1/health answers 200,
`SHOW DATABASES` lists `tracking` — right up until the first real query returns
"Table 'tracking.tracking' doesn't exist". Nothing else in this repo surfaces
that gap.

Read-only by construction: every check is a SELECT, a SHOW, an HTTP GET or a
`docker inspect`. It fixes nothing and changes nothing — it tells you which
command to run. That is deliberate. A doctor that repairs is a doctor you cannot
trust to diagnose, because you can no longer tell whether it found the system
healthy or made it so.

Exit codes: 0 everything checked passed, 1 at least one check failed.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

from lib3mrai.console import inf, no, ok
from lib3mrai.db import COMPOSE_NETWORK, discover_port

FLOCI_URL = "http://localhost:4566"
NGINX_ALIAS = "nginx-stable"

# Database -> the tables its migrations are expected to have created. Checked by
# name rather than counted: a partially-applied migration set is a real state,
# and "3 of 4 tables" is the kind of thing that otherwise reads as fine.
# Names are SINGULAR for Orders (`order`, `product`) and match the db-naming
# convention; they were verified against a live database rather than guessed,
# because a doctor that reports tables missing when they are merely named
# differently is worse than no doctor at all.
EXPECTED_TABLES = {
    "orders": {"order", "order_details", "product", "configuration"},
    "tracking": {"tracking", "tracking_history"},
}

# HOST ports, as published in docker-compose.yml — not the container-side ports,
# which differ for two of the three ("3001:8080" for orders, "3002:8000" for
# tracking). Probing 8080 on the host finds whatever else is listening there
# rather than Orders, which on this machine was an unrelated Express process
# answering 404 — a false failure that looks exactly like a real one.
SERVICE_PORTS = {"users": 3000, "orders": 3001, "tracking": 3002}

# 127.0.0.1, never "localhost". On this machine `localhost` resolves to ::1
# first, and Docker's published ports do not all answer on IPv6 — probing
# orders over ::1 returns a 404 from something else entirely while 127.0.0.1
# returns a healthy 200. A diagnostic that reports a working service as broken
# because of address-family resolution order is worse than no diagnostic.
LOOPBACK = "127.0.0.1"


class Report:
    """Accumulates results so one failure does not hide the rest."""

    def __init__(self) -> None:
        self.failures: list[str] = []

    def passed(self, msg: str) -> None:
        ok(msg)

    def failed(self, msg: str, remedy: str) -> None:
        no(msg)
        inf(f"    fix: {remedy}")
        self.failures.append(msg)


def _docker(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, text=True)


def _mysql(port: int, sql: str) -> subprocess.CompletedProcess:
    """Run SQL in a throwaway client on the compose network.

    Same shape as the provisioning scripts: resolves `floci` by name, and
    --ssl-mode=DISABLED because Floci's proxy does not terminate TLS.
    """
    return subprocess.run(
        [
            "docker", "run", "--rm", "--network", COMPOSE_NETWORK, "mysql:8",
            "mysql", "--ssl-mode=DISABLED", "-h", "floci", "-P", str(port),
            "-u", "test", "-ptest", "-N", "-B", "-e", sql,
        ],
        capture_output=True,
        text=True,
    )


def check_floci(report: Report) -> bool:
    """Nothing else can be true if the emulator is down, so this gates the rest."""
    try:
        urllib.request.urlopen(FLOCI_URL, timeout=5)
        report.passed("Floci is up")
        return True
    except (urllib.error.URLError, OSError) as exc:
        report.failed(f"Floci is not reachable at {FLOCI_URL} ({exc})", "make bootstrap")
        return False


def check_containers(report: Report) -> None:
    result = subprocess.run(
        ["docker", "compose", "ps", "--format", "{{.Service}}\t{{.State}}"],
        capture_output=True,
        text=True,
    )
    running = {
        line.split("\t")[0]
        for line in result.stdout.strip().splitlines()
        if "\t" in line and line.split("\t")[1] == "running"
    }
    for service in ("floci", "users", "orders", "tracking"):
        if service in running:
            report.passed(f"container '{service}' running")
        else:
            report.failed(
                f"container '{service}' is not running",
                f"docker compose up -d {service}",
            )


def check_nginx_alias(report: Report) -> None:
    """The alias the API Gateway routes through — its absence is a 502 at the gateway."""
    found = _docker("ps", "--filter", "name=nginx", "-q")
    container = found.stdout.strip().splitlines()
    if not container:
        report.failed(
            "no nginx container (Floci ECS task not running)",
            "make bootstrap-converge",
        )
        return

    inspected = _docker(
        "inspect", container[0],
        "--format", "{{json .NetworkSettings.Networks}}",
    )
    try:
        networks = json.loads(inspected.stdout or "{}")
    except json.JSONDecodeError:
        networks = {}

    aliases = [a for net in networks.values() for a in (net.get("Aliases") or [])]
    if NGINX_ALIAS in aliases:
        report.passed(f"nginx alias '{NGINX_ALIAS}' attached")
    else:
        report.failed(
            f"nginx alias '{NGINX_ALIAS}' NOT attached — the API Gateway will 502",
            ".venv/bin/python infra/environments/local/bootstrap.py",
        )


def check_databases_and_tables(report: Report) -> None:
    """The check this script exists for: database present, tables missing."""
    try:
        port = discover_port("mysql")
    except LookupError as exc:
        report.failed(f"MySQL cluster not found ({exc})", "make bootstrap")
        return

    shown = _mysql(port, "SHOW DATABASES;")
    if shown.returncode != 0:
        report.failed(
            f"cannot reach MySQL on floci:{port} ({shown.stderr.strip()[:120]})",
            "make bootstrap",
        )
        return

    databases = set(shown.stdout.split())
    for database, expected in EXPECTED_TABLES.items():
        if database not in databases:
            report.failed(
                f"database '{database}' does not exist",
                "make infra-up  (phase-1 terraform creates it)",
            )
            continue

        listed = _mysql(port, f"SHOW TABLES IN `{database}`;")
        tables = set(listed.stdout.split())
        missing = expected - tables

        if not missing:
            report.passed(f"database '{database}': {len(expected)} expected tables present")
        elif missing == expected:
            # The exact JE-112 symptom, called out by name so the reader
            # recognises it rather than re-deriving it.
            remedy = (
                "make migrate-tracking" if database == "tracking"
                else "docker compose up -d --build orders  (it self-migrates)"
            )
            report.failed(
                f"database '{database}' EXISTS but has NO tables — migrations never ran",
                remedy,
            )
        else:
            report.failed(
                f"database '{database}' is missing tables: {', '.join(sorted(missing))}",
                "make migrate-tracking" if database == "tracking" else "check EF Core migrations",
            )


def check_services(report: Report, attempts: int = 3, sleep_s: int = 2) -> None:
    """Probe each service's health endpoint, retrying briefly.

    A few seconds of grace rather than a single shot: a container that started
    moments ago is not a broken container, and reporting it as one is precisely
    the mistake this whole exercise came from (JE-112). Short, though — this is
    a diagnostic, and a doctor that hangs for a minute per service is one nobody
    runs.
    """
    for service, port in SERVICE_PORTS.items():
        detail = ""
        for attempt in range(1, attempts + 1):
            try:
                with urllib.request.urlopen(
                    f"http://{LOOPBACK}:{port}/v1/health", timeout=5
                ) as response:
                    if response.status == 200:
                        report.passed(f"{service} answers /v1/health on :{port}")
                        break
                    detail = f"HTTP {response.status}"
            except (urllib.error.URLError, OSError) as exc:
                detail = str(exc)
            if attempt < attempts:
                time.sleep(sleep_s)
        else:
            report.failed(
                f"{service} does not answer /v1/health on :{port} ({detail})",
                f"docker compose logs {service} --tail 50",
            )


def main() -> int:
    report = Report()

    print("== Floci ==")
    if not check_floci(report):
        # Everything below reads through Floci; continuing would produce a
        # screenful of failures that all say the same thing.
        no("Floci is down — skipping the remaining checks, they would all fail.")
        return 1

    print("\n== Containers ==")
    check_containers(report)

    print("\n== Gateway routing ==")
    check_nginx_alias(report)

    print("\n== Databases and migrations ==")
    check_databases_and_tables(report)

    print("\n== Service health ==")
    check_services(report)

    print()
    if report.failures:
        no(f"{len(report.failures)} check(s) failed — see the fix lines above.")
        inf("a partly-finished bootstrap usually resumes with: make bootstrap-converge")
        return 1

    ok("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
