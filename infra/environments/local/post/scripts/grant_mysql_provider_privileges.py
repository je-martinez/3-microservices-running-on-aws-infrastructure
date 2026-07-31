#!/usr/bin/env python3
"""Grant the local MySQL `test` user what phase 2's mysql provider needs.

Usage: grant_mysql_provider_privileges.py

WHY PHASE 2 NEEDS THIS BEFORE ITS `mysql` PROVIDER DOES ANYTHING
----------------------------------------------------------------
`environments/local/post/providers.tf` configures the petoju/mysql provider as
`local.master` — the same `test` user the services connect as locally — and then
asks it to create least-privilege app-users (`orders_app`, `tracking_app`) with
their grants. Floci's emulated MySQL grants `test` only `USAGE ON *.*` plus
`ALL PRIVILEGES` on the databases it owns, which is not enough for that: without
the two grants below, `make post-infra` fails first with 1227 on `CREATE USER`,
and then — once that is worked around — with 1142 reading `mysql.user` to diff
the grants it just wrote. `WITH GRANT OPTION` is the third prerequisite; it is
granted per-database by `environments/local/scripts/create_mysql_database.py`,
which is genuinely about the database it creates, so it stays there.

This script is a PURE RELOCATION, not new behavior. These exact two GRANTs used
to live in `create_mysql_database.py`'s `_sql()`, issued by the same `root`
identity over the same throwaway `mysql:8` container, purely because phase 1
happened to be the only place already running as root. They belonged to phase 2
all along; only the script that issues them and the phase it runs in change.

WHY root ISSUES THEM
--------------------
`test` cannot grant itself `CREATE USER ON *.*` — that is the privilege it is
missing. Floci's emulated MySQL does expose a working `root`/`test` superuser
through its RDS proxy (verified: it holds `CREATE USER ... WITH GRANT OPTION ON
*.*`), so this connects as root purely to issue the grants.

LOCAL-ONLY. In production the app users are provisioned by a privileged operator
or a managed bootstrap, never by handing the runtime user `CREATE USER ON *.*`.

Idempotent and re-runnable: MySQL treats a re-issued GRANT the user already
holds as a no-op, so every apply may run this safely.

Execution is recorded to the DynamoDB execution log (lib3mrai.execution_log) for
traceability — never to skip a re-run. With EXECUTION_LOG_TABLE unset (a hand
run outside the Makefile/Terraform chain) nothing is recorded and the script
behaves identically.

Exit codes: 0 granted (or already held), 1 failure.
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

# Exactly the two statements that moved out of create_mysql_database.py, plus a
# FLUSH so the running server picks them up without waiting for a reconnect.
SQL = (
    f"GRANT CREATE USER ON *.* TO '{PROVIDER_USER}'@'%'; "
    f"GRANT SELECT ON mysql.* TO '{PROVIDER_USER}'@'%'; "
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
            # BEHAVIORAL SEAM: grant_privileges reports failure by RETURNING
            # False (having already emitted the operator-facing `no(...)` with
            # MySQL's own stderr), but record_execution can only detect failure
            # from an exception. Left untranslated, a genuine failure would be
            # recorded as "ok" — the worst possible outcome for a traceability
            # log. So the False is raised here, purely so the wrapper observes
            # it, and caught immediately below to restore the script's exit-code
            # contract (0/1, never an uncaught traceback).
            if not grant_privileges(port):
                raise RuntimeError("failed to grant provider privileges")
    except RuntimeError:
        return 1

    ok(f"phase-2 provider privileges present for '{PROVIDER_USER}'")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
