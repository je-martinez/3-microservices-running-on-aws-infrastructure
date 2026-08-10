#!/usr/bin/env python3
"""Idempotently create the ElastiCache Redis replication group via boto3.

Used ONLY by modules/redis/main.tf's terraform_data.group_via_cli, which is
gated by var.manage_via_provider = false (Floci local only).

WHY THIS SCRIPT EXISTS AT ALL
-----------------------------
The native `aws_elasticache_replication_group` resource does not merely fail
against Floci — it CRASHES the provider (verified 2026-08-09, provider pinned
`= 5.31.0`):

    panic: runtime error: index out of range [0] with length 0
    .../internal/service/elasticache/replication_group.go:632
    .../internal/service/elasticache/replication_group.go:575
    Error: The terraform-provider-aws_v5.31.0_x5 plugin crashed!

Root cause: after CreateReplicationGroup the provider reads `NodeGroups[0]` off
the response to populate primary_endpoint_address / reader_endpoint_address.
Floci's response has NO `NodeGroups` key at all — it reports only
`ConfigurationEndpoint` (confirmed against both create_replication_group and
describe_replication_groups) — so the provider indexes an empty slice.

That is worse than an ordinary error: the group IS created in Floci before the
panic, but the crash means nothing lands in Terraform state, so a retry fails
with ReplicationGroupAlreadyExistsFault and the root is wedged. The identical
CreateReplicationGroup call through boto3 succeeds and returns Status
"available".

That meets the criterion in docs/shared/patterns/awscli-fallback-for-floci.md:
the native resource demonstrably cannot apply (proven by a real crash, not
speculation), the SDK call demonstrably can. Production keeps the native
resource — this path is local-only.

WHY A REPLICATION GROUP AND NOT A CACHE CLUSTER
----------------------------------------------
`create_cache_cluster(Engine="redis")` is REJECTED by Floci with
"Engine must be 'memcached'. For Redis/Valkey use CreateReplicationGroup."
Real AWS points the same way. So Redis is a replication group, full stop.

IDEMPOTENCY, AND THE FLOCI QUIRK IT HAS TO WORK AROUND
------------------------------------------------------
Re-running this must be a no-op, not an error, because `make bootstrap` tears the
stack down and rebuilds it routinely and terraform_data re-runs the provisioner
whenever its `input` changes.

The quirk: on a duplicate create Floci returns the CORRECT error code
(`ReplicationGroupAlreadyExistsFault`) but botocore does NOT map it to the
modeled exception class — `except ec.exceptions.ReplicationGroupAlreadyExistsFault`
does not catch it, only a bare ClientError does (verified empirically). So this
script matches on `Error.Code` rather than on the modeled class. Catching the
modeled class alone would look correct and fail every re-run.

Describe-on-a-miss behaves like real AWS here (raises
ReplicationGroupNotFoundFault) rather than returning an empty list the way
Floci's docdb describe does, but both shapes are handled anyway — a lookup that
lies must not turn a re-run into a failed apply.

THE CONTAINER-NAME CONTRACT
---------------------------
Floci backs each replication group with a `valkey/valkey:8` container named
`floci-valkey-<ReplicationGroupId>`, attached to 3mrai_3mrai-network with NO
host port published. That container name is the ONLY way a service reaches
Redis: the API reports ConfigurationEndpoint.Address = "localhost", which from
inside the network resolves to the caller's own container.

So REPLICATION_GROUP_ID passed in here must be exactly the id the rest of the
stack expects; the module derives both from the same expression, so they cannot
drift. Same shape as the DocumentDB contract in modules/docdb.

Required env vars (set by the calling local-exec provisioner):
  REPLICATION_GROUP_ID - replication group id (drives the container name)
  STATE_FILE           - path to write the resulting descriptor JSON

Optional:
  DESCRIPTION          - group description (required by the API; defaulted here)
  ENGINE               - "redis" or "valkey" (default redis)
  ENGINE_VERSION       - engine version (Floci runs valkey:8 regardless)
  NODE_TYPE            - cache node type (Floci ignores it)
  NUM_CACHE_CLUSTERS   - number of nodes (default 1)
  PORT                 - listening port (default 6379)
  SUBNET_GROUP_NAME    - cache subnet group; EMPTY locally, see below
  SECURITY_GROUP_IDS   - comma-separated VPC security group ids
  ENDPOINT_URL         - endpoint override (empty = real-AWS resolution)
  AWS_REGION           - AWS region
  EXECUTION_LOG_TABLE  - DynamoDB traceability table (never skips a run)

SUBNET_GROUP_NAME is empty against Floci on purpose: it implements no
subnet-group API at all (both CreateCacheSubnetGroup and
DescribeCacheSubnetGroups answer UnsupportedOperation), and unlike RDS/DocumentDB
there is no pre-existing "default" group to point at either. Sending the
parameter anyway would reference a group that cannot exist.

Exit codes: 0 created-or-already-present, 1 failure.
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
    """Write the descriptor data.local_file.group_via_cli reads back.

    The KEY NAMES ARE A CONTRACT: the module's outputs jsondecode this file and
    read ReplicationGroupId / Address / Port out of it.

    Address comes from ConfigurationEndpoint, which is the ONLY endpoint Floci
    reports — there is no NodeGroups array (that absence is precisely what
    crashes the native provider). Its value is the literal string "localhost",
    which is NOT usable from inside the Docker network; the module's redis_host
    output deliberately ignores it and returns the backing container name
    instead. It is carried here for parity and debugging only.
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
