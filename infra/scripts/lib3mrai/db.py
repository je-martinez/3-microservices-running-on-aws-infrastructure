"""Database discovery and readiness helpers for the local Floci stack."""

import subprocess
import time

from . import aws

# Floci's compose network. The readiness probes run INSIDE a throwaway container
# joined to it, so they resolve the `floci` service by name — the same network
# the app containers use.
COMPOSE_NETWORK = "3mrai_3mrai-network"


def discover_port(engine: str) -> int:
    """Return the RDS-proxy port Floci assigned to `engine`'s cluster.

    Floci assigns those ports (7000-7099) by cluster CREATION ORDER, which is
    NOT stable across applies: with two clusters (Users Postgres + Orders
    MySQL) the assignment can flip, so one apply yields postgres=7001/
    mysql=7002 and another yields the reverse. Any code that hardcodes
    7001=Postgres breaks whenever Floci flips them.

    describe_db_clusters exposes `Engine` per cluster, so the port is resolved
    for a given engine instead of guessed by position.

    Raises LookupError when no cluster matches the engine.
    """
    clusters = aws.client("rds").describe_db_clusters().get("DBClusters", [])
    for cluster in clusters:
        if cluster.get("Engine") == engine and cluster.get("Port"):
            return int(cluster["Port"])
    raise LookupError(
        f"no {engine} cluster/port found via describe-db-clusters "
        "(is Floci up and applied?)"
    )


def _probe_command(engine: str, host: str, port: int) -> list[str]:
    """The readiness-probe argv for `engine`, run in a throwaway container."""
    if engine == "postgres":
        return [
            "docker", "run", "--rm", "--network", COMPOSE_NETWORK,
            "postgres:14.6-alpine",
            "pg_isready", "-h", host, "-p", str(port),
        ]
    if engine == "mysql":
        # --ssl-mode=DISABLED: Floci's emulated MySQL proxy does not terminate
        # TLS, so the client's default SSL handshake fails with
        # "unexpected eof while reading".
        return [
            "docker", "run", "--rm", "--network", COMPOSE_NETWORK,
            "mysql:8",
            "mysqladmin", "ping", "--ssl-mode=DISABLED",
            "-h", host, "-P", str(port), "--silent",
        ]
    raise ValueError(f"unknown engine: {engine}")


def wait_for_db(
    host: str, port: int, engine: str, attempts: int = 30, sleep_s: int = 2
) -> bool:
    """Poll until `engine` at host:port accepts connections.

    Returns True as soon as it is ready, False if it never became ready within
    `attempts`. Raises ValueError for an unknown engine.
    """
    # Resolve the engine first, so an unknown one fails immediately instead of
    # after the full retry budget.
    _probe_command(engine, host, port)

    for attempt in range(1, attempts + 1):
        result = subprocess.run(
            _probe_command(engine, host, port), capture_output=True, text=True
        )
        if result.returncode == 0:
            return True
        print(f"waiting for {engine} at {host}:{port} ({attempt}/{attempts})…")
        time.sleep(sleep_s)
    return False
