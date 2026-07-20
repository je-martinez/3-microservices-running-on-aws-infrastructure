#!/usr/bin/env python3
"""Idempotent Cognito App Client creation via boto3.

Used ONLY by modules/cognito/main.tf's terraform_data.client_via_cli, which is
gated by var.manage_client_via_provider = false (Floci local only — see that
variable's description for why the native aws_cognito_user_pool_client resource
cannot be used against Floci).

Idempotent: if a client with CLIENT_NAME already exists under USER_POOL_ID, it
is reused (its id written to STATE_FILE) instead of creating a duplicate on
every re-apply.

Required env vars (set by the calling local-exec provisioner):
  USER_POOL_ID  - Cognito User Pool id the client belongs to
  CLIENT_NAME   - name of the App Client (used for idempotent lookup)
  STATE_FILE    - path to write the resulting {"ClientId": "..."} JSON
  ENDPOINT_URL  - optional endpoint override (empty = default resolution)
  AWS_REGION    - AWS region
"""

import json
import os
import pathlib
import sys

# The provisioner passes the endpoint as ENDPOINT_URL, while lib3mrai.aws reads
# AWS_ENDPOINT_URL. Bridge them BEFORE importing/using the client factory,
# preserving the contract that an empty value means "resolve real AWS".
if "ENDPOINT_URL" in os.environ:
    os.environ["AWS_ENDPOINT_URL"] = os.environ["ENDPOINT_URL"]

from lib3mrai import aws  # noqa: E402  (must follow the env bridge above)

# Must match what the native resource sets (modules/cognito/main.tf,
# aws_cognito_user_pool_client.this) so the CLI and provider paths agree.
EXPLICIT_AUTH_FLOWS = [
    "ALLOW_ADMIN_USER_PASSWORD_AUTH",
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
]


def require(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        print(f"create_user_pool_client.py: {name} is required", file=sys.stderr)
        sys.exit(1)
    return value


def write_state(state_file: pathlib.Path, client_id: str, pool_id: str) -> None:
    """Write the descriptor data.local_file.client_via_cli reads back.

    The shape is a contract: output.client_id is parsed out of this file.
    """
    state_file.write_text(json.dumps({"ClientId": client_id, "UserPoolId": pool_id}))


def main() -> int:
    pool_id = require("USER_POOL_ID")
    client_name = require("CLIENT_NAME")
    state_file = pathlib.Path(require("STATE_FILE"))
    state_file.parent.mkdir(parents=True, exist_ok=True)

    idp = aws.client("cognito-idp")

    # 1. Idempotent lookup: reuse an existing client with the same name, if any.
    existing = idp.list_user_pool_clients(UserPoolId=pool_id, MaxResults=60)
    for candidate in existing.get("UserPoolClients", []):
        if candidate.get("ClientName") == client_name:
            client_id = candidate["ClientId"]
            write_state(state_file, client_id, pool_id)
            print(
                f"create_user_pool_client.py: reused existing client "
                f"'{client_name}' ({client_id})"
            )
            return 0

    # 2. Create the client.
    created = idp.create_user_pool_client(
        UserPoolId=pool_id,
        ClientName=client_name,
        GenerateSecret=False,
        ExplicitAuthFlows=EXPLICIT_AUTH_FLOWS,
    )
    client_id = created["UserPoolClient"]["ClientId"]
    write_state(state_file, client_id, pool_id)
    print(f"create_user_pool_client.py: created client '{client_name}' ({client_id})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
