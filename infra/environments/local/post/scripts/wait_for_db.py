#!/usr/bin/env python3
"""Poll a DB endpoint until it accepts connections, or fail after a timeout.

Usage: wait_for_db.py <host> <port> <engine:postgres|mysql>

CONTRACT: Do NOT change these exit codes — gate.tf depends on them. 0 ready,
1 timeout, 2 unknown engine or usage error; the execution-log wrapper never
changes which code is returned. The probe runs inside a throwaway container on
3mrai_3mrai-network so it resolves `floci` by name, like the app containers do.
Env: WAIT_ATTEMPTS (30), WAIT_SLEEP (2), optional EXECUTION_LOG_TABLE.
See [[two-phase-terraform-apply]]
"""

import os
import sys

from lib3mrai.db import wait_for_db
from lib3mrai.execution_log import record_execution


class NotReady(RuntimeError):
    """The DB never accepted a connection within the timeout.

    CONTRACT: Raise, do NOT return 1 here. record_execution sees exceptions
    only, so a returned code is recorded as "ok". main() catches this and
    returns 1 unchanged, keeping gate.tf's dependency on the exit codes intact.
    """


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(
            "wait_for_db.py: usage: wait_for_db.py <host> <port> <engine>",
            file=sys.stderr,
        )
        return 2

    host, engine = argv[1], argv[3]
    try:
        port = int(argv[2])
    except ValueError:
        print(f"wait_for_db.py: port must be a number, got '{argv[2]}'", file=sys.stderr)
        return 2

    attempts = int(os.environ.get("WAIT_ATTEMPTS", "30"))
    sleep_s = int(os.environ.get("WAIT_SLEEP", "2"))

    # The DB being probed is the resource; host:port is the closest identity
    # available here (no cluster id reaches this script).
    resource_id = f"{host}:{port}"

    try:
        with record_execution(script="wait_for_db.py", resource_id=resource_id):
            ready = wait_for_db(host, port, engine, attempts, sleep_s)
            if not ready:
                print(
                    f"timed out waiting for {engine} at {host}:{port}", file=sys.stderr
                )
                raise NotReady(f"timed out waiting for {engine} at {host}:{port}")
    except NotReady:
        return 1
    except ValueError as exc:
        # Unknown engine — a usage error, exit 2 like the two checks above.
        # wait_for_db validates the engine before its first probe, so this
        # raises immediately; it is caught OUTSIDE the `with` so the code stays
        # 2 rather than being folded into the timeout's 1. The record does get
        # opened and closed as "failed" in this case, which is accurate: the
        # run happened and did not succeed.
        print(f"wait_for_db.py: {exc}", file=sys.stderr)
        return 2

    print(f"{engine} at {host}:{port} ready")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
