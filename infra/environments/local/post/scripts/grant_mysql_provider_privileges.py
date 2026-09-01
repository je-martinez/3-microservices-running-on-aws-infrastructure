#!/usr/bin/env python3
"""WORKAROUND(local): Do NOT run phase 2's MySQL provider before these root
grants; it fails with 1227, 1142, or 1044 while managing app users.
CONTRACT: Keep this local-only; granting runtime users CREATE USER in prod
crosses the privilege boundary. Production uses privileged provisioning.
See [[floci-rds-apigw-limits]], [[execution-log-for-provisioning-scripts]]
"""

import subprocess
import sys

from lib3mrai.console import inf, no, ok
from lib3mrai.db import COMPOSE_NETWORK, discover_port
from lib3mrai.execution_log import record_execution

# Floci's only reachable MySQL superuser. Not a secret: Floci fixes it at
# test/test (MYSQL_ROOT_PASSWORD=test on the container it launches).
ROOT_USER = "root"
ROOT_PASSWORD = "test"

# The identity phase 2's mysql provider connects as — the grantee here.
PROVIDER_USER = "test"

FLOCI_HOST = "floci"

# The database Floci creates with the cluster itself, via
# aws_rds_cluster.database_name. Unlike `tracking`, it never passes through
# create_mysql_database.py, so nothing ever granted `test` GRANT OPTION on it.
CLUSTER_OWNED_DATABASE = "orders"

# The two statements that moved out of create_mysql_database.py, plus the
# GRANT OPTION this script must add itself, plus a FLUSH so the running server
# picks them up without waiting for a reconnect.
SQL = (
    f"GRANT CREATE USER ON *.* TO '{PROVIDER_USER}'@'%'; "
    f"GRANT SELECT ON mysql.* TO '{PROVIDER_USER}'@'%'; "
    # CONTRACT: Do NOT omit GRANT OPTION for the cluster-created `orders` DB.
    # Phase 2 runs as `test` and otherwise fails with MySQL 1044 while granting
    # privileges to orders_app.
    f"GRANT ALL PRIVILEGES ON `{CLUSTER_OWNED_DATABASE}`.* "
    f"TO '{PROVIDER_USER}'@'%' WITH GRANT OPTION; "
    "FLUSH PRIVILEGES;"
)


def grant_privileges(port: int) -> bool:
    """Issue the grants as root. Returns True on success."""
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
            "-e", SQL,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        no(
            f"could not grant provider privileges to '{PROVIDER_USER}': "
            f"{result.stderr.strip()}"
        )
        return False
    return True


def main(argv: list[str]) -> int:
    # WHY: Discover the port because Floci assigns it by unstable creation order.
    # Keep discovery outside the execution log: a miss has no resource identity
    # to record.
    try:
        port = discover_port("mysql")
    except LookupError as exc:
        no(f"grant_mysql_provider_privileges.py: {exc}")
        return 1

    # The MySQL cluster reached through this proxy port is the resource acted
    # on; the port identifies it as precisely as anything available here (the
    # provisioner passes no cluster id, and discover_port matches on Engine).
    resource_id = f"mysql:{FLOCI_HOST}:{port}"

    try:
        with record_execution(
            script="grant_mysql_provider_privileges.py", resource_id=resource_id
        ):
            inf(
                f"granting phase-2 provider privileges to '{PROVIDER_USER}' "
                f"on {FLOCI_HOST}:{port} …"
            )
            # CONTRACT: Do NOT return False inside record_execution; it records
            # the failed run as "ok". Raise here, then restore exit code 1 below.
            # See [[execution-log-for-provisioning-scripts]]
            if not grant_privileges(port):
                raise RuntimeError("failed to grant provider privileges")
    except RuntimeError:
        return 1

    ok(f"phase-2 provider privileges present for '{PROVIDER_USER}'")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
