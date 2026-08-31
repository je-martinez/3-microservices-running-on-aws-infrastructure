#!/usr/bin/env python3
"""WORKAROUND(local): Do NOT use the MySQL provider to create Tracking's
database in phase 1; its endpoint is absent on clean apply and it hangs on Floci.
CONTRACT: Keep WITH GRANT OPTION when granting `test`; phase 2 otherwise fails
with MySQL 1044 while delegating app-user privileges. Prod uses privileged setup.
See [[floci-rds-apigw-limits]], [[execution-log-for-provisioning-scripts]]
"""

import argparse
import subprocess
import sys

from lib3mrai.console import inf, no, ok
from lib3mrai.db import COMPOSE_NETWORK, discover_port
from lib3mrai.execution_log import record_execution

# Floci's only reachable MySQL superuser. Not a secret: Floci fixes it at
# test/test (MYSQL_ROOT_PASSWORD=test on the container it launches).
ROOT_USER = "root"
ROOT_PASSWORD = "test"

# The user the services connect as locally — the new database is granted to it.
APP_USER = "test"

FLOCI_HOST = "floci"


def _sql(database: str) -> str:
    """Idempotent DDL: safe to re-run on every apply.

    utf8mb4/utf8mb4_unicode_ci matches what MySQL 8 defaults to for new
    databases and what the Orders database already uses — spelled out rather
    than inherited so the collation cannot drift with a server default.
    """
    return (
        f"CREATE DATABASE IF NOT EXISTS `{database}` "
        "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; "
        f"GRANT ALL PRIVILEGES ON `{database}`.* TO '{APP_USER}'@'%' "
        # CONTRACT: Do NOT remove WITH GRANT OPTION. Phase 2 delegates this
        # database to its app user as `test` and otherwise fails with MySQL 1044.
        "WITH GRANT OPTION; "
        "FLUSH PRIVILEGES;"
    )


def create_database(database: str, port: int) -> bool:
    """Run the DDL. Returns True on success."""
    result = subprocess.run(
        [
            "docker", "run", "--rm", "--network", COMPOSE_NETWORK,
            "mysql:8",
            "mysql",
            # Floci's MySQL proxy does not terminate TLS, so the client's
            # default handshake fails with "unexpected eof while reading".
            "--ssl-mode=DISABLED",
            "-h", FLOCI_HOST,
            "-P", str(port),
            "-u", ROOT_USER,
            f"-p{ROOT_PASSWORD}",
            "-e", _sql(database),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        no(f"could not create database '{database}': {result.stderr.strip()}")
        return False
    return True


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", help="database/schema name to create")
    args = parser.parse_args(argv[1:])

    # WHY: Discover the port because Floci assigns it by unstable creation order.
    # Keep discovery outside the execution log: a miss has no resource identity
    # to record.
    try:
        port = discover_port("mysql")
    except LookupError as exc:
        no(f"create_mysql_database.py: {exc}")
        return 1

    # The MySQL cluster reached through this proxy port is the resource acted
    # on; the port identifies it as precisely as anything available here (the
    # provisioner passes no cluster id, and discover_port matches on Engine).
    resource_id = f"mysql:{FLOCI_HOST}:{port}"

    try:
        with record_execution(
            script="create_mysql_database.py", resource_id=resource_id
        ):
            inf(f"creating MySQL database '{args.database}' on {FLOCI_HOST}:{port} …")
            # CONTRACT: Do NOT return False inside record_execution; it records
            # the failed run as "ok". Raise here, then restore exit code 1 below.
            # See [[execution-log-for-provisioning-scripts]]
            if not create_database(args.database, port):
                raise RuntimeError(f"failed to create database '{args.database}'")
    except RuntimeError:
        return 1

    ok(f"MySQL database '{args.database}' present (granted to '{APP_USER}')")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
