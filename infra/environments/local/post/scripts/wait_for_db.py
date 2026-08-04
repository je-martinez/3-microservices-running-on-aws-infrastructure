#!/usr/bin/env python3
"""Poll a DB endpoint until it accepts connections, or fail after a timeout.

Usage: wait_for_db.py <host> <port> <engine:postgres|mysql>

Runs the probe INSIDE a throwaway container joined to Floci's compose network
(3mrai_3mrai-network) so it resolves the `floci` service by name — the same
network the app containers use.

Exit codes (unchanged from the bash version — gate.tf depends on them):
  0 ready, 1 timeout, 2 unknown engine or usage error.

A healthcheck rather than a mutation, but wrapped in the DynamoDB execution log
like the other three provisioning scripts so the record of a provisioning
sequence is complete. The usage errors (wrong arg count, non-numeric port) exit
2 BEFORE the DB target is known — there is no resource identity to record them
against, so they stay outside the wrapper entirely. The unknown-engine case
also exits 2, but only after host:port is known, so it is recorded as a failed
run; the wrapper never changes which code is returned.

Overridable via env: WAIT_ATTEMPTS (default 30), WAIT_SLEEP (default 2).
Optional: EXECUTION_LOG_TABLE — unset records nothing and behaves as before.
"""

import os
import sys

from lib3mrai.db import wait_for_db
from lib3mrai.execution_log import record_execution


class NotReady(RuntimeError):
    """The DB never accepted a connection within the timeout.

    Raised so record_execution observes the timeout: that path reported failure
    by RETURNING 1, which the wrapper cannot detect (it sees exceptions only)
    and would have recorded as "ok". main() catches it and returns 1 unchanged,
    keeping gate.tf's dependency on the exit codes intact.
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
