#!/usr/bin/env python3
"""Discover the RDS-proxy port Floci assigned to a cluster, BY ENGINE.

Usage: discover_db_port.py <engine:postgres|mysql>

Prints ONLY the port to stdout so callers can capture it — the Makefile does
`pgport="$($(PY) $(DISCOVER_DB_PORT) postgres)"`, so any stray output would end
up inside a connection string. Diagnostics go to stderr.

Exit codes: 0 ok, 1 engine's cluster/port not found, 2 usage error.

This is the SINGLE reusable discovery mechanism: the Makefile calls it as a CLI
and bootstrap.py imports lib3mrai.db.discover_port directly (DRY).

AWS creds/endpoint for Floci come from the environment (AWS_ENDPOINT_URL /
AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION); the Makefile exports
them, and lib3mrai.aws defaults them so the script also works standalone.
"""

import sys

from lib3mrai.db import discover_port


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(
            "discover_db_port.py: missing engine argument (postgres|mysql)",
            file=sys.stderr,
        )
        return 2
    try:
        print(discover_port(argv[1]))
    except LookupError as exc:
        print(f"discover_db_port.py: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
