#!/usr/bin/env python3
"""Report which state the local stack is actually in.

The blind spot this exists for: a database can exist while its tables do not.
Phase 1 creates the `tracking` database, migrations create its tables, and
everything between reports healthy until the first query fails.

CONTRACT: Keep every check READ-ONLY. A doctor that repairs cannot be trusted to
diagnose: its report stops saying whether it found the system healthy or made it
so. Exit 0 everything passed, 1 at least one check failed.
See [[2026-08-27-accumulated-local-state-degrades-the-stack-silently]]
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from lib3mrai.console import inf, no, ok
from lib3mrai.db import COMPOSE_NETWORK, discover_port

FLOCI_URL = "http://localhost:4566"
NGINX_ALIAS = "nginx-stable"

# WHY: Read as files, not from a running container — the question is whether a
# service is CONFIGURED to export, true whether or not it is currently up.
TRACE_EXPORTING_ENV_FILES = (
    ".env.local.users",
    ".env.local.orders",
    ".env.local.tracking",
)

# WHY: Derived from this file's location, not the cwd, so the checks read the
# same env files wherever the doctor is invoked from.
ROOT = Path(__file__).resolve().parents[2]

# CONTRACT: Check tables BY NAME, never by count. A partially-applied migration
# set is a real state, and "3 of 4 tables" reads as fine. Orders' names are
# singular (`order`, `product`) per the db-naming convention.
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

# The collector's health_check extension, as configured in
# observability/otel-collector-config.yaml and published in docker-compose.yml.
# Deliberately NOT the OTLP ingest ports (4317/4318): those answer only to a
# well-formed OTLP payload, so probing them would mean sending a synthetic trace
# just to ask whether the collector is alive.
OTEL_COLLECTOR_HEALTH_URL = f"http://{LOOPBACK}:13133"


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


def check_assets(report: Report) -> None:
    """Assert the email templates' images are actually being served.

    CONTRACT: Fetch an object, do NOT list the bucket. A bucket created but never
    synced is empty, and an empty bucket renders the same broken images as a
    missing one — visible only in a delivered message.
    """
    env_file = ROOT / ".env.local.events-pipeline"
    if not env_file.exists():
        inf(f"    Assets: {env_file.name} not generated yet (skipped)")
        return

    base = ""
    for line in env_file.read_text().splitlines():
        if line.startswith("ASSETS_BASE_URL="):
            base = line.split("=", 1)[1].strip()
    if not base:
        inf(f"    Assets: no ASSETS_BASE_URL in {env_file.name} (skipped)")
        return

    # The header logo: present in every template, so its absence is the whole
    # email family broken, not one image.
    url = f"{base.rstrip('/')}/email/logo.png"
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            status = response.status
    except urllib.error.HTTPError as exc:
        status = exc.code
    except (urllib.error.URLError, OSError) as exc:
        report.failed(
            f"assets are not reachable at {base} ({exc}) — email templates will "
            "render with broken images",
            "make post-infra && make assets-sync",
        )
        return

    if status == 200:
        report.passed("email assets are being served")
    else:
        report.failed(
            f"assets returned HTTP {status} for {url} — email templates will "
            "render with broken images",
            "make post-infra && make assets-sync",
        )


def check_docdb_host(report: Report) -> None:
    """Assert the container DOCDB_HOST names actually exists.

    CONTRACT: Read the generated env file, NOT the AWS API — Floci's docdb API
    does not report this cluster. A missing container here is the `getaddrinfo
    ENOTFOUND floci-docdb-…` that aborts every batch and mails nothing.
    """
    env_file = ROOT / ".env.local.events-pipeline"
    if not env_file.exists():
        inf(f"    DocumentDB: {env_file.name} not generated yet (skipped)")
        return

    host = ""
    for line in env_file.read_text().splitlines():
        if line.startswith("DOCDB_HOST="):
            host = line.split("=", 1)[1].strip()
    if not host:
        inf(f"    DocumentDB: no DOCDB_HOST in {env_file.name} (skipped)")
        return

    if _docker("ps", "--filter", f"name={host}", "-q").stdout.strip():
        report.passed(f"DocumentDB container '{host}' running")
    else:
        report.failed(
            f"DOCDB_HOST '{host}' has NO container — the events pipeline cannot "
            "resolve it, so no email will ever be sent",
            "make clean && make bootstrap",
        )


def check_phantom_resources(report: Report) -> None:
    """Catch resources the emulator reports `available` with no container behind them.

    WORKAROUND(local): Floci answers `available` from persisted state, so a
    resource whose backing container is gone looks healthy to every AWS API call,
    Terraform's included — an apply against that state creates NOTHING and reports
    success, surfacing much later as `getaddrinfo ENOTFOUND floci-docdb-…`.
    Only DocumentDB and ElastiCache go phantom: Floci relaunches RDS containers at
    boot and Lambda containers respawn on invocation, but these two have no such
    reconciler. Container names are deterministic, so they are asserted, not
    discovered. See [[floci-recreate-destroys-backing-containers]]
    """
    check_docdb_host(report)

    probes = (
        ("ElastiCache", "elasticache", "describe-replication-groups",
         "ReplicationGroups[].ReplicationGroupId", "floci-valkey-"),
    )

    for label, service, action, query, prefix in probes:
        result = subprocess.run(
            ["aws", "--endpoint-url", FLOCI_URL, service, action,
             "--query", query, "--output", "text"],
            capture_output=True,
            text=True,
            env={**os.environ, "AWS_ACCESS_KEY_ID": "test",
                 "AWS_SECRET_ACCESS_KEY": "test", "AWS_DEFAULT_REGION": "us-east-1"},
        )
        if result.returncode != 0:
            # Not a failure: the resource may legitimately not exist yet (a
            # bootstrap that has not reached it). Reporting it as broken would
            # make the doctor cry wolf on a half-built stack.
            inf(f"    {label}: could not query (skipped)")
            continue

        identifiers = [i for i in result.stdout.split() if i and i != "None"]
        if not identifiers:
            inf(f"    {label}: no clusters declared (skipped)")
            continue

        for identifier in identifiers:
            container = f"{prefix}{identifier}"
            found = _docker("ps", "--filter", f"name={container}", "-q")
            if found.stdout.strip():
                report.passed(f"{label} '{identifier}' has a running container")
            else:
                report.failed(
                    f"{label} '{identifier}' reports available but has NO container "
                    f"({container}) — stale emulator state",
                    "make clean && make bootstrap",
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

    CONTRACT: Keep the grace short but non-zero. A container that started moments
    ago is not a broken one, and a doctor that hangs a minute per service is one
    nobody runs.
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


def check_otel_collector(report: Report) -> None:
    """Catch services configured to export traces at a collector that is not running.

    CONTRACT: Every component of the tracing path must appear in a
    `make observability-*` target, not only in a compose profile — one left out
    of the targets simply never runs. The defect is invisible from the service
    side: a span export is not part of a request, so the SDK drops the batch and
    the service keeps answering 200, with the exporter's retries buried in the
    collector's own log. See [[logging-context]]

    Reported only for services actually configured to export.
    """
    configured = [
        name for name in TRACE_EXPORTING_ENV_FILES
        if (ROOT / name).exists()
        and "OTEL_EXPORTER_OTLP_ENDPOINT" in (ROOT / name).read_text()
    ]
    if not configured:
        inf("    Tracing: no service exports traces yet (skipped)")
        return

    try:
        with urllib.request.urlopen(OTEL_COLLECTOR_HEALTH_URL, timeout=3) as response:
            if response.status == 200:
                report.passed(
                    f"otel-collector is reachable on :13133 "
                    f"({len(configured)} service(s) exporting traces)"
                )
                return
            detail = f"HTTP {response.status}"
    except urllib.error.HTTPError as exc:
        # An answer, even a non-200 one, still proves something is listening —
        # but not that it is healthy, so it is reported rather than passed.
        detail = f"HTTP {exc.code}"
    except (urllib.error.URLError, OSError) as exc:
        detail = str(exc)

    report.failed(
        f"{', '.join(configured)} set OTEL_EXPORTER_OTLP_ENDPOINT but the "
        f"otel-collector is NOT reachable at {OTEL_COLLECTOR_HEALTH_URL} "
        f"({detail}) — every span is being dropped, silently",
        "make observability-up",
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

    print("\n== Emulator state vs reality ==")
    check_phantom_resources(report)

    print("\n== Email assets ==")
    check_assets(report)

    print("\n== Gateway routing ==")
    check_nginx_alias(report)

    print("\n== Databases and migrations ==")
    check_databases_and_tables(report)

    print("\n== Service health ==")
    check_services(report)

    print("\n== Tracing ==")
    check_otel_collector(report)

    print()
    if report.failures:
        no(f"{len(report.failures)} check(s) failed — see the fix lines above.")
        inf("a partly-finished bootstrap usually resumes with: make bootstrap-converge")
        return 1

    ok("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
