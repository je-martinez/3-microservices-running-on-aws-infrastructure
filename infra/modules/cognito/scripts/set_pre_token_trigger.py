#!/usr/bin/env python3
"""Idempotent Cognito Pre-Token-Generation V2 trigger wiring via boto3.

WORKAROUND(local): Provider 5.31.0's aws_cognito_user_pool `lambda_config` has
no `pre_token_generation_config` sub-block, so the V2 trigger cannot be declared
natively. This registers it outside Terraform's resource lifecycle.
CONTRACT: UpdateUserPool is a PUT, not a PATCH. Passing ONLY LambdaConfig resets
every other pool setting to service defaults — re-tightening the relaxed local
password policy and breaking E2E signups. The current pool is read back, the
accepted fields kept, and the whole thing re-applied.
See [[awscli-fallback-for-floci]]
"""

# Schema and custom attributes are create-only on UpdateUserPool and are
# deliberately not touched, so custom:app_user_id is safe.
#
# Env vars from the calling provisioner. Required: USER_POOL_ID, LAMBDA_ARN,
# ENDPOINT_URL (empty = default resolution), AWS_REGION. Optional:
# EXECUTION_LOG_TABLE; unset records nothing and never skips a run.

# Env vars set by the calling local-exec provisioner. Required: USER_POOL_ID,
# LAMBDA_ARN, ENDPOINT_URL (empty = default resolution), AWS_REGION. Optional:
# EXECUTION_LOG_TABLE, a DynamoDB table recording this run; unset means record
# nothing, and the log never skips a run.

import os
import sys

# The provisioner passes the endpoint as ENDPOINT_URL, while lib3mrai.aws reads
# AWS_ENDPOINT_URL. Bridge them BEFORE using the client factory, preserving the
# contract that an empty value means "resolve real AWS".
if "ENDPOINT_URL" in os.environ:
    os.environ["AWS_ENDPOINT_URL"] = os.environ["ENDPOINT_URL"]

from lib3mrai import aws  # noqa: E402  (must follow the env bridge above)
from lib3mrai.execution_log import record_execution  # noqa: E402  (same reason)

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


class TriggerNotWired(RuntimeError):
    """The post-update verification found the trigger absent.

    CONTRACT: Raise, do NOT return 1. The execution-log wrapper detects failure
    only from an exception, so a returned code is recorded as "ok" — a log
    claiming a run succeeded when it did not. main() restores exit code 1.
    """


def main() -> int:
    # require() exits(1) on a missing var, before the pool id is known — so it
    # stays outside the execution-log wrapper: there would be no resource
    # identity to record the run against.
    pool_id = require("USER_POOL_ID")
    lambda_arn = require("LAMBDA_ARN")

    try:
        with record_execution(script="set_pre_token_trigger.py", resource_id=pool_id):
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
            idp.update_user_pool(
                UserPoolId=pool_id, LambdaConfig=lambda_config, **preserved
            )

            # 4. Verify the trigger landed — independent confirmation by re-reading the
            #    pool, not merely trusting that the call did not raise.
            wired = (
                idp.describe_user_pool(UserPoolId=pool_id)["UserPool"]
                .get("LambdaConfig", {})
                .get("PreTokenGenerationConfig", {})
                .get("LambdaArn", "")
            )
            if wired != lambda_arn:
                # Printed here, not in the handler, so the operator-facing
                # message and its stderr stream are exactly what they were.
                print(
                    f"set_pre_token_trigger.py: FAILED — trigger not wired "
                    f"(got '{wired}', want '{lambda_arn}')",
                    file=sys.stderr,
                )
                raise TriggerNotWired(
                    f"trigger not wired (got '{wired}', want '{lambda_arn}')"
                )
    except TriggerNotWired:
        return 1

    print(
        f"set_pre_token_trigger.py: wired Pre-Token-Generation V2 trigger on "
        f"{pool_id} -> {lambda_arn} (existing pool settings preserved)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
