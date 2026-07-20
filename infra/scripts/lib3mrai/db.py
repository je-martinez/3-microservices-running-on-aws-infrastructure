"""Database discovery and readiness helpers for the local Floci stack."""

from . import aws


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
