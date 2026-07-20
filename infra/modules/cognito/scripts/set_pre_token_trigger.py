#!/usr/bin/env python3
"""Idempotent Cognito Pre-Token-Generation V2 trigger wiring via boto3.

Used ONLY by modules/cognito/main.tf's terraform_data.pre_token_trigger, a
Floci-only workaround (same pattern as terraform_data.client_via_cli /
create_user_pool_client.py): the AWS provider is pinned to 5.31.0 (ADR-0016),
whose aws_cognito_user_pool `lambda_config` block has no
`pre_token_generation_config` sub-block, so the V2 trigger cannot be declared
natively at that provider version. This script registers it directly, outside
Terraform's resource lifecycle.

Idempotent: UpdateUserPool is declarative, so re-running with the same
USER_POOL_ID/LAMBDA_ARN yields the same pool state.

SETTINGS-PRESERVING ─────────────────────────────────────────────────────────
UpdateUserPool is a PUT, not a PATCH. A call that passes ONLY LambdaConfig
would reset every OTHER top-level pool setting (password Policies,
AutoVerifiedAttributes, AdminCreateUserConfig, …) to service defaults — which
would silently re-tighten the intentionally relaxed local password policy and
break E2E signups. So this reads the current pool, keeps the fields
UpdateUserPool accepts, injects the V2 LambdaConfig, and re-applies the whole
thing.

Schema/custom attributes are NOT re-passable via UpdateUserPool (they are
create-only plus add-custom-attributes) and are deliberately NOT touched here,
so custom:app_user_id is safe.

Required env vars (set by the calling local-exec provisioner):
  USER_POOL_ID  - Cognito User Pool id to wire the trigger on
  LAMBDA_ARN    - ARN of the Pre-Token-Generation V2 Lambda
  ENDPOINT_URL  - optional endpoint override (empty = default resolution)
  AWS_REGION    - AWS region
"""

import os
import sys

# The provisioner passes the endpoint as ENDPOINT_URL, while lib3mrai.aws reads
# AWS_ENDPOINT_URL. Bridge them BEFORE using the client factory, preserving the
# contract that an empty value means "resolve real AWS".
if "ENDPOINT_URL" in os.environ:
    os.environ["AWS_ENDPOINT_URL"] = os.environ["ENDPOINT_URL"]

from lib3mrai import aws  # noqa: E402  (must follow the env bridge above)

# Fields describe_user_pool returns that update_user_pool also accepts, so they
# survive the PUT. `Schema` is absent ON PURPOSE (create-only — see the module
# docstring). Names are the boto3 parameter names, which match the response
# keys one-to-one.
PRESERVED_FIELDS = [
    "Policies",
    "DeletionProtection",
    "AutoVerifiedAttributes",
    "VerificationMessageTemplate",
    "SmsAuthenticationMessage",
    "UserAttributeUpdateSettings",
    "MfaConfiguration",
    "DeviceConfiguration",
    "EmailConfiguration",
    "SmsConfiguration",
    "UserPoolTags",
    "AdminCreateUserConfig",
    "UserPoolAddOns",
    "AccountRecoverySetting",
]


def require(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        print(f"set_pre_token_trigger.py: {name} is required", file=sys.stderr)
        sys.exit(1)
    return value


def main() -> int:
    pool_id = require("USER_POOL_ID")
    lambda_arn = require("LAMBDA_ARN")
    idp = aws.client("cognito-idp")

    # 1. Read the current pool.
    pool = idp.describe_user_pool(UserPoolId=pool_id)["UserPool"]

    # 2. Preserve the existing LambdaConfig, add/override the Pre-Token V2 trigger.
    lambda_config = dict(pool.get("LambdaConfig", {}))
    lambda_config["PreTokenGenerationConfig"] = {
        "LambdaVersion": "V2_0",
        "LambdaArn": lambda_arn,
    }

    # 3. Re-apply: current settings preserved + trigger wired. Empty values are
    #    dropped rather than sent back, since some of them are rejected as
    #    explicit empties even though describe returns them that way.
    preserved = {
        field: pool[field]
        for field in PRESERVED_FIELDS
        if pool.get(field) not in (None, "", {}, [])
    }
    idp.update_user_pool(UserPoolId=pool_id, LambdaConfig=lambda_config, **preserved)

    # 4. Verify the trigger landed — independent confirmation by re-reading the
    #    pool, not merely trusting that the call did not raise.
    wired = (
        idp.describe_user_pool(UserPoolId=pool_id)["UserPool"]
        .get("LambdaConfig", {})
        .get("PreTokenGenerationConfig", {})
        .get("LambdaArn", "")
    )
    if wired != lambda_arn:
        print(
            f"set_pre_token_trigger.py: FAILED — trigger not wired "
            f"(got '{wired}', want '{lambda_arn}')",
            file=sys.stderr,
        )
        return 1

    print(
        f"set_pre_token_trigger.py: wired Pre-Token-Generation V2 trigger on "
        f"{pool_id} -> {lambda_arn} (existing pool settings preserved)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
