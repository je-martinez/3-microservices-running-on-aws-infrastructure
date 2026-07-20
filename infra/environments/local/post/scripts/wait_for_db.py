#!/usr/bin/env python3
"""Poll a DB endpoint until it accepts connections, or fail after a timeout.

Usage: wait_for_db.py <host> <port> <engine:postgres|mysql>

Runs the probe INSIDE a throwaway container joined to Floci's compose network
(3mrai_3mrai-network) so it resolves the `floci` service by name — the same
network the app containers use.

Exit codes (unchanged from the bash version — gate.tf depends on them):
  0 ready, 1 timeout, 2 unknown engine or usage error.

Overridable via env: WAIT_ATTEMPTS (default 30), WAIT_SLEEP (default 2).
"""

import os
import sys

from lib3mrai.db import wait_for_db


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

    try:
        ready = wait_for_db(host, port, engine, attempts, sleep_s)
    except ValueError as exc:
        print(f"wait_for_db.py: {exc}", file=sys.stderr)
        return 2

    if ready:
        print(f"{engine} at {host}:{port} ready")
        return 0

    print(f"timed out waiting for {engine} at {host}:{port}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
