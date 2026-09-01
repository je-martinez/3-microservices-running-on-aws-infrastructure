#!/usr/bin/env python3
"""WORKAROUND(local): Do NOT use the native resource against Floci; provider
5.31.0 panics after creating the group and wedges Terraform state. Prod uses it.
CONTRACT: Do NOT change REPLICATION_GROUP_ID; it names the only reachable
floci-valkey-<id> container, and consumers otherwise get ECONNREFUSED.
See [[floci-elasticache-two-ports-and-provider-panic]]
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

from botocore.exceptions import ClientError  # noqa: E402  (must follow the env bridge)

from lib3mrai import aws  # noqa: E402  (same reason)
from lib3mrai.console import inf, ok  # noqa: E402  (same reason)
from lib3mrai.execution_log import record_execution  # noqa: E402  (same reason)

DEFAULT_ENGINE = "redis"
DEFAULT_NODE_TYPE = "cache.t4g.micro"
DEFAULT_NUM_CACHE_CLUSTERS = 1

# Redis's own default, and the port Floci's backing container listens on. Read
# from the API response where available, with this only as the fallback.
DEFAULT_PORT = 6379

# Floci returns this code on a duplicate create but botocore does NOT map it to
# the modeled exception class (see the module docstring), so it is matched as a
# string against ClientError.
ALREADY_EXISTS_CODE = "ReplicationGroupAlreadyExistsFault"
NOT_FOUND_CODE = "ReplicationGroupNotFoundFault"


def require(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        print(f"create_replication_group.py: {name} is required", file=sys.stderr)
        sys.exit(1)
    return value


def _error_code(exc: ClientError) -> str:
    return exc.response.get("Error", {}).get("Code", "")


def find_group(elasticache, group_id: str) -> dict | None:
    """Return the replication group with `group_id`, or None when absent.

    Handles both shapes a "miss" can take: the modeled NotFound fault, the same
    fault arriving as a bare ClientError (Floci's mapping is unreliable — see the
    module docstring), and an empty list.
    """
    try:
        response = elasticache.describe_replication_groups(
            ReplicationGroupId=group_id
        )
    except ClientError as exc:
        if _error_code(exc) == NOT_FOUND_CODE:
            return None
        raise
    for group in response.get("ReplicationGroups", []):
        if group.get("ReplicationGroupId") == group_id:
            return group
    return None


def ensure_group(elasticache, group_id: str) -> tuple[dict, bool]:
    """Create the replication group if absent. Returns (group, created)."""
    existing = find_group(elasticache, group_id)
    if existing is not None:
        return existing, False

    params = {
        "ReplicationGroupId": group_id,
        "ReplicationGroupDescription": os.environ.get("DESCRIPTION")
        or f"Redis replication group {group_id}",
        "Engine": os.environ.get("ENGINE") or DEFAULT_ENGINE,
        "CacheNodeType": os.environ.get("NODE_TYPE") or DEFAULT_NODE_TYPE,
        "NumCacheClusters": int(
            os.environ.get("NUM_CACHE_CLUSTERS") or DEFAULT_NUM_CACHE_CLUSTERS
        ),
        "Port": int(os.environ.get("PORT") or DEFAULT_PORT),
    }
    if os.environ.get("ENGINE_VERSION"):
        params["EngineVersion"] = os.environ["ENGINE_VERSION"]
    # Omitted entirely when empty — Floci implements no subnet-group API, so
    # naming one would reference a group that cannot exist (see the docstring).
    if os.environ.get("SUBNET_GROUP_NAME"):
        params["CacheSubnetGroupName"] = os.environ["SUBNET_GROUP_NAME"]
    security_group_ids = [
        sg.strip()
        for sg in os.environ.get("SECURITY_GROUP_IDS", "").split(",")
        if sg.strip()
    ]
    if security_group_ids:
        params["SecurityGroupIds"] = security_group_ids

    try:
        created = elasticache.create_replication_group(**params)["ReplicationGroup"]
    except ClientError as exc:
        if _error_code(exc) != ALREADY_EXISTS_CODE:
            raise
        # Lost a race, or a describe that under-reports. Either way the desired
        # end state holds, which is all this script promises.
        found = find_group(elasticache, group_id)
        if found is None:
            raise
        return found, False
    return created, True


def write_state(state_file: pathlib.Path, group: dict, group_id: str) -> None:
    """CONTRACT: Keep ReplicationGroupId/Address/Port; outputs decode these keys.
    WORKAROUND(local): Do NOT route consumers to Floci's reported `localhost`;
    inside Docker it reaches the caller and returns ECONNREFUSED. The module's
    redis_host output supplies the backing container name instead.
    See [[floci-elasticache-two-ports-and-provider-panic]]
    """
    endpoint = group.get("ConfigurationEndpoint") or {}
    state_file.write_text(
        json.dumps(
            {
                "ReplicationGroupId": group_id,
                "Address": endpoint.get("Address", ""),
                "Port": int(
                    endpoint.get("Port")
                    or os.environ.get("PORT")
                    or DEFAULT_PORT
                ),
            }
        )
    )


def main() -> int:
    # require() exits(1) before the group identity is known, so these stay
    # OUTSIDE the execution-log wrapper: there would be no resource identity to
    # record the run against (same reasoning as create_docdb_cluster.py).
    group_id = require("REPLICATION_GROUP_ID")
    state_file = pathlib.Path(require("STATE_FILE"))
    state_file.parent.mkdir(parents=True, exist_ok=True)

    with record_execution(
        script="create_replication_group.py", resource_id=group_id
    ):
        elasticache = aws.client("elasticache")

        group, created = ensure_group(elasticache, group_id)
        if created:
            inf(f"created ElastiCache replication group '{group_id}'")
        else:
            inf(f"ElastiCache replication group '{group_id}' already exists — reused")

        # Re-read rather than trusting the create response: this is the
        # independent verification the awscli-fallback pattern asks for, and it
        # also refreshes Address/Port on the reuse path, where the create
        # response does not exist at all.
        final = find_group(elasticache, group_id)
        if final is None:
            raise RuntimeError(
                f"ElastiCache replication group '{group_id}' not found after "
                "create — Floci accepted the call but the group is absent"
            )
        write_state(state_file, final, group_id)

    ok(
        f"ElastiCache replication group '{group_id}' present "
        f"(container floci-valkey-{group_id}, port "
        f"{(final.get('ConfigurationEndpoint') or {}).get('Port', DEFAULT_PORT)})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
