#!/usr/bin/env python3
"""Discover the RDS-proxy port Floci assigned to a cluster, BY ENGINE.

Usage: discover_db_port.py <engine:postgres|mysql>

CONTRACT: Do NOT hardcode an RDS proxy port. Floci assigns 7000-7099 by cluster
CREATION ORDER, not stable across applies — postgres and mysql have been seen
swapped. This is the single discovery mechanism.
CONTRACT: Print ONLY the port to stdout — the Makefile captures it straight into
a connection string, so stray output corrupts it. Diagnostics go to stderr.
Exit codes: 0 ok, 1 not found, 2 usage. See [[floci-rds-apigw-limits]]
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
