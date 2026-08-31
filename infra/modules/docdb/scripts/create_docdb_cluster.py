#!/usr/bin/env python3
"""WORKAROUND(local): Do NOT manage this cluster with the native resource;
provider 5.31.0 returns 403 while boto3 succeeds. Prod uses native resources.
CONTRACT: Do NOT change CLUSTER_IDENTIFIER; it names the only reachable
floci-docdb-<id> container, and consumers otherwise get ECONNREFUSED.
See [[awscli-fallback-for-floci]], [[floci-sqs-lambda-docdb-support]]
"""

import json
import os
import pathlib
import sys

# The provisioner passes the endpoint as ENDPOINT_URL, while lib3mrai.aws reads
# AWS_ENDPOINT_URL. Bridge them BEFORE importing the client factory, preserving
# the contract that an EMPTY value means "resolve real AWS".
if "ENDPOINT_URL" in os.environ:
    os.environ["AWS_ENDPOINT_URL"] = os.environ["ENDPOINT_URL"]

from lib3mrai import aws  # noqa: E402  (must follow the env bridge above)
from lib3mrai.console import inf, ok  # noqa: E402  (same reason)
from lib3mrai.execution_log import record_execution  # noqa: E402  (same reason)

DEFAULT_INSTANCE_CLASS = "db.t3.medium"

# Floci's docdb port. Fixed by the mongo:7.0 container it launches, and echoed
# back by create_db_cluster — read from the API response rather than assumed,
# with this only as the fallback when the response omits it.
DEFAULT_PORT = 27017


def require(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        print(f"create_docdb_cluster.py: {name} is required", file=sys.stderr)
        sys.exit(1)
    return value


def find_cluster(docdb, identifier: str) -> dict | None:
    """Return the cluster with `identifier`, or None when it does not exist.

    Floci answers a miss with an empty DBClusters list; real AWS raises
    DBClusterNotFoundFault. Both are "absent" (see the module docstring).
    """
    try:
        clusters = docdb.describe_db_clusters(DBClusterIdentifier=identifier)
    except docdb.exceptions.DBClusterNotFoundFault:
        return None
    for cluster in clusters.get("DBClusters", []):
        if cluster.get("DBClusterIdentifier") == identifier:
            return cluster
    return None


def instance_exists(docdb, identifier: str) -> bool:
    """Whether the DB instance exists.

    Queried BY IDENTIFIER on purpose: Floci's unfiltered describe_db_instances
    returns [] even when the instance is present (verified), so a list-and-scan
    would recreate it on every run.
    """
    try:
        instances = docdb.describe_db_instances(DBInstanceIdentifier=identifier)
    except docdb.exceptions.DBInstanceNotFoundFault:
        return False
    return any(
        inst.get("DBInstanceIdentifier") == identifier
        for inst in instances.get("DBInstances", [])
    )


def ensure_cluster(docdb, identifier: str) -> tuple[dict, bool]:
    """Create the cluster if absent. Returns (cluster, created)."""
    existing = find_cluster(docdb, identifier)
    if existing is not None:
        return existing, False

    params = {
        "DBClusterIdentifier": identifier,
        "Engine": "docdb",
        "MasterUsername": require("MASTER_USERNAME"),
        "MasterUserPassword": require("MASTER_PASSWORD"),
    }
    if os.environ.get("ENGINE_VERSION"):
        params["EngineVersion"] = os.environ["ENGINE_VERSION"]
    if os.environ.get("SUBNET_GROUP_NAME"):
        params["DBSubnetGroupName"] = os.environ["SUBNET_GROUP_NAME"]
    security_group_ids = [
        sg.strip() for sg in os.environ.get("SECURITY_GROUP_IDS", "").split(",") if sg.strip()
    ]
    if security_group_ids:
        params["VpcSecurityGroupIds"] = security_group_ids

    try:
        created = docdb.create_db_cluster(**params)["DBCluster"]
    except docdb.exceptions.DBClusterAlreadyExistsFault:
        # Lost a race, or a describe that under-reports. Either way the desired
        # end state holds, which is all this script promises.
        found = find_cluster(docdb, identifier)
        if found is None:
            raise
        return found, False
    return created, True


def ensure_instance(docdb, cluster_identifier: str, identifier: str) -> bool:
    """Create the cluster instance if absent. Returns True when it created one.

    Floci backs the CLUSTER with the mongo container, so the instance is not what
    makes Mongo reachable — it exists to mirror the native module's shape (real
    AWS requires at least one instance to serve traffic).
    """
    if instance_exists(docdb, identifier):
        return False
    try:
        docdb.create_db_instance(
            DBInstanceIdentifier=identifier,
            DBClusterIdentifier=cluster_identifier,
            DBInstanceClass=os.environ.get("INSTANCE_CLASS") or DEFAULT_INSTANCE_CLASS,
            Engine="docdb",
        )
    except docdb.exceptions.DBInstanceAlreadyExistsFault:
        # Belt and braces for quirk #2: the describe above can report absent for
        # an instance that exists, and a re-apply must not fail on that.
        return False
    return True


def write_state(state_file: pathlib.Path, cluster: dict, identifier: str) -> None:
    """Write the descriptor data.local_file.cluster_via_cli reads back.

    The KEY NAMES ARE A CONTRACT: the module's outputs jsondecode this file and
    read ClusterIdentifier / Endpoint / Port / MasterUsername out of it, so they
    match the native resource's attributes one-for-one.
    """
    state_file.write_text(
        json.dumps(
            {
                "ClusterIdentifier": identifier,
                "Endpoint": cluster.get("Endpoint", ""),
                "Port": int(cluster.get("Port") or DEFAULT_PORT),
                "MasterUsername": cluster.get(
                    "MasterUsername", os.environ.get("MASTER_USERNAME", "")
                ),
            }
        )
    )


def main() -> int:
    # require() exits(1) before the cluster identity is known, so these stay
    # OUTSIDE the execution-log wrapper: there would be no resource identity to
    # record the run against (same reasoning as create_user_pool_client.py).
    cluster_identifier = require("CLUSTER_IDENTIFIER")
    instance_identifier = require("INSTANCE_IDENTIFIER")
    state_file = pathlib.Path(require("STATE_FILE"))
    state_file.parent.mkdir(parents=True, exist_ok=True)

    with record_execution(
        script="create_docdb_cluster.py", resource_id=cluster_identifier
    ):
        docdb = aws.client("docdb")

        cluster, cluster_created = ensure_cluster(docdb, cluster_identifier)
        if cluster_created:
            inf(f"created DocumentDB cluster '{cluster_identifier}'")
        else:
            inf(f"DocumentDB cluster '{cluster_identifier}' already exists — reused")

        instance_created = ensure_instance(
            docdb, cluster_identifier, instance_identifier
        )
        if instance_created:
            inf(f"created DocumentDB instance '{instance_identifier}'")
        else:
            inf(f"DocumentDB instance '{instance_identifier}' already exists — reused")

        # Re-read rather than trusting the create response: this is the
        # independent verification the awscli-fallback pattern asks for, and it
        # also refreshes Endpoint/Port on the reuse path, where the create
        # response does not exist at all.
        final = find_cluster(docdb, cluster_identifier)
        if final is None:
            raise RuntimeError(
                f"DocumentDB cluster '{cluster_identifier}' not found after "
                "create — Floci accepted the call but the cluster is absent"
            )
        write_state(state_file, final, cluster_identifier)

    ok(
        f"DocumentDB cluster '{cluster_identifier}' present "
        f"(container floci-docdb-{cluster_identifier}, port {final.get('Port')})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
