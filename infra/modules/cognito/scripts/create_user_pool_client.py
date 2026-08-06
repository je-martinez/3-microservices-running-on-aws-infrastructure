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

Optional:
  EXECUTION_LOG_TABLE - DynamoDB table recording this run for traceability
                        (lib3mrai.execution_log). Unset = record nothing and
                        behave exactly as before; the log never skips a run.
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
from lib3mrai.execution_log import record_execution  # noqa: E402  (same reason)

# Must match what the native resource sets (modules/cognito/main.tf,
# aws_cognito_user_pool_client.this) so the CLI and provider paths agree.
#
# This is the list that actually takes effect LOCALLY: the native resource is
# count = 0 under Floci (manage_client_via_provider = false), so adding a flow
# only there would leave CUSTOM_AUTH rejected on every local login attempt.
EXPLICIT_AUTH_FLOWS = [
    "ALLOW_ADMIN_USER_PASSWORD_AUTH",
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    # Passwordless email-OTP: AdminInitiateAuth(AuthFlow="CUSTOM_AUTH") ->
    # DefineAuthChallenge/CreateAuthChallenge/VerifyAuthChallengeResponse.
    "ALLOW_CUSTOM_AUTH",
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


def reconcile_auth_flows(idp, pool_id: str, client_id: str) -> bool:
    """Bring a REUSED client's ExplicitAuthFlows up to EXPLICIT_AUTH_FLOWS.

    The reuse branch used to return the existing client untouched, which meant a
    flow added to EXPLICIT_AUTH_FLOWS only took effect on a pool created from
    scratch — on an existing pool the client kept the old flow set and the new
    flow was rejected at auth time with no sign of why. Adding ALLOW_CUSTOM_AUTH
    is exactly that case.

    UpdateUserPoolClient is a PUT, so the current client description is read and
    re-sent with only ExplicitAuthFlows replaced. Read-only/create-only fields
    the API rejects on update are dropped. Returns True when an update was sent.
    """
    described = idp.describe_user_pool_client(UserPoolId=pool_id, ClientId=client_id)[
        "UserPoolClient"
    ]

    if set(described.get("ExplicitAuthFlows", [])) >= set(EXPLICIT_AUTH_FLOWS):
        return False

    # Fields describe returns that update does NOT accept (create-only or
    # server-computed). Everything else is passed straight back so the PUT does
    # not reset it.
    read_only = {
        "UserPoolId",
        "ClientId",
        "ClientName",
        "ClientSecret",
        "LastModifiedDate",
        "CreationDate",
    }
    payload = {k: v for k, v in described.items() if k not in read_only}
    payload["ExplicitAuthFlows"] = EXPLICIT_AUTH_FLOWS

    idp.update_user_pool_client(
        UserPoolId=pool_id, ClientId=client_id, ClientName=described["ClientName"], **payload
    )
    return True


def main() -> int:
    # require() exits(1) on a missing var, before the pool id is known — so it
    # stays outside the execution-log wrapper: there would be no resource
    # identity to record the run against.
    pool_id = require("USER_POOL_ID")
    client_name = require("CLIENT_NAME")
    state_file = pathlib.Path(require("STATE_FILE"))
    state_file.parent.mkdir(parents=True, exist_ok=True)

    # Both branches below `return 0` from inside the `with`, which leaves the
    # context manager normally and closes the record as "ok" — correct for
    # reuse and create alike. A boto3 error propagates instead, closing it as
    # "failed" and surfacing unchanged, exactly as before this wrapper existed.
    with record_execution(script="create_user_pool_client.py", resource_id=pool_id):
        idp = aws.client("cognito-idp")

        # 1. Idempotent lookup: reuse an existing client with the same name, if any.
        existing = idp.list_user_pool_clients(UserPoolId=pool_id, MaxResults=60)
        for candidate in existing.get("UserPoolClients", []):
            if candidate.get("ClientName") == client_name:
                client_id = candidate["ClientId"]
                reconciled = reconcile_auth_flows(idp, pool_id, client_id)
                write_state(state_file, client_id, pool_id)
                print(
                    f"create_user_pool_client.py: reused existing client "
                    f"'{client_name}' ({client_id})"
                    + (" (auth flows reconciled)" if reconciled else "")
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
        print(
            f"create_user_pool_client.py: created client '{client_name}' ({client_id})"
        )
        return 0


if __name__ == "__main__":
    sys.exit(main())
