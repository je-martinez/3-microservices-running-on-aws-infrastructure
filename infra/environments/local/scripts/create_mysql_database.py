#!/usr/bin/env python3
"""Idempotently create an extra database (schema) on the local MySQL cluster.

Usage: create_mysql_database.py <database-name>

WHY THIS SCRIPT EXISTS AT ALL
-----------------------------
Terraform's `aws_rds_cluster.database_name` creates exactly ONE database per
cluster, at cluster-creation time. Orders got `orders` that way. Tracking needs
a SECOND database on the SAME cluster, and there is no AWS API (and therefore no
Terraform AWS resource) for "add a database to an existing RDS cluster" — that
is a DDL statement against the engine, not a control-plane call.

The obvious alternative — a `mysql_database` resource from the petoju/mysql
provider — is not usable here: that provider is configured with the cluster
endpoint, which does not exist yet on a clean apply (the same chicken-and-egg
that forced `manage_app_user = false` on both clusters), and it is separately
known to HANG against Floci (see infra/CLAUDE.md and the floci-mysql-no-user-mgmt
lesson). So this follows the repo's established awscli-fallback shape instead:
`terraform_data` + `local-exec` + an idempotent Python script that runs AFTER
the cluster resource exists.

WHY THE `test` USER CANNOT DO THIS, AND `root` CAN
--------------------------------------------------
Floci's emulated MySQL grants `test` only `USAGE ON *.*` plus
`ALL PRIVILEGES ON orders.*`. `CREATE DATABASE tracking` as `test` fails with
`ERROR 1044 Access denied`. Verified empirically that the underlying container
DOES expose a working `root`/`test` superuser through Floci's RDS proxy (it has
`CREATE, DROP, ... CREATE USER ... WITH GRANT OPTION ON *.*`), so this script
connects as root purely to run the DDL, then grants the new database to `test`
— the user the application actually connects as locally.

This is LOCAL-ONLY. In production the database is created by the cluster's own
`database_name` (Tracking would get its own cluster or a provisioning step run
by a privileged operator), and the app user is the least-privilege one from the
phase-2 post-effects root, never root.

Runs the client inside a throwaway `mysql:8` container joined to Floci's compose
network, exactly like lib3mrai.db's readiness probes — so it resolves the `floci`
service by name and needs no mysql client on the host.

Execution is recorded to the DynamoDB execution log (lib3mrai.execution_log) for
traceability — never to skip a re-run. With EXECUTION_LOG_TABLE unset (a hand
run outside the Makefile/Terraform chain) nothing is recorded and the script
behaves exactly as it did before.

Exit codes: 0 created-or-already-present, 1 failure.
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
        # WITH GRANT OPTION is load-bearing beyond this script: phase 2 grants
        # this database to its least-privilege app-user AS this same user, and
        # you cannot hand out privileges you do not hold with it. The two
        # *other* provider-enablement grants that used to live here (CREATE USER
        # ON *.*, SELECT ON mysql.*) moved to phase 2, where they are used —
        # post/scripts/grant_mysql_provider_privileges.py.
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

    # Discovered, never hardcoded: Floci assigns RDS proxy ports 7000-7099 by
    # cluster CREATION ORDER, which is not stable across applies.
    #
    # OUTSIDE the execution-log wrapper on purpose: a failure here means the
    # MySQL cluster was never found, so there is no resource identity to record
    # the run against — the same reasoning that keeps wait_for_db.py's usage
    # error (exit 2) outside its wrapper.
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
            # BEHAVIORAL SEAM: create_database reports failure by RETURNING
            # False (having already emitted the operator-facing `no(...)` with
            # MySQL's own stderr), but record_execution can only detect failure
            # from an exception. Left untranslated, a genuine failure would be
            # recorded as "ok" — the worst possible outcome for a traceability
            # log. So the False is raised here, purely so the wrapper observes
            # it, and caught immediately below to restore the script's exit-code
            # contract (0/1, never an uncaught traceback).
            if not create_database(args.database, port):
                raise RuntimeError(f"failed to create database '{args.database}'")
    except RuntimeError:
        return 1

    ok(f"MySQL database '{args.database}' present (granted to '{APP_USER}')")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
