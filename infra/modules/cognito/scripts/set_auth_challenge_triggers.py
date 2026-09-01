#!/usr/bin/env python3
"""WORKAROUND(local): Do NOT split the three challenge-trigger updates; each
PUT replaces LambdaConfig and leaves only the last trigger wired.
CONTRACT: Preserve pool settings and PreTokenGenerationConfig on the PUT;
dropping them breaks E2E signups or removes app_user_id from issued tokens.
See [[awscli-fallback-for-floci]], [[cognito-pre-token-lambda]]
"""

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
# docstring). Names are the boto3 parameter names, which match the response keys
# one-to-one. Kept identical to set_pre_token_trigger.py's list: the two scripts
# PUT the same pool, so a field preserved by one and dropped by the other would
# be reset depending on which ran last.
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

# LambdaConfig keys this script owns, mapped to the env var carrying each ARN.
TRIGGER_ENV_VARS = {
    "DefineAuthChallenge": "DEFINE_AUTH_CHALLENGE_LAMBDA_ARN",
    "CreateAuthChallenge": "CREATE_AUTH_CHALLENGE_LAMBDA_ARN",
    "VerifyAuthChallengeResponse": "VERIFY_AUTH_CHALLENGE_RESPONSE_LAMBDA_ARN",
}


def require(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        print(f"set_auth_challenge_triggers.py: {name} is required", file=sys.stderr)
        sys.exit(1)
    return value


class TriggersNotWired(RuntimeError):
    """WHY: An exception lets the execution log observe verification failures.
    Returning 1 inside the wrapper records false success; main restores exit 1.
    """


def main() -> int:
    # require() exits(1) on a missing var, before the pool id is known — so it
    # stays outside the execution-log wrapper: there would be no resource
    # identity to record the run against.
    pool_id = require("USER_POOL_ID")
    wanted = {key: require(env) for key, env in TRIGGER_ENV_VARS.items()}

    try:
        with record_execution(
            script="set_auth_challenge_triggers.py", resource_id=pool_id
        ):
            idp = aws.client("cognito-idp")

            # 1. Read the current pool.
            pool = idp.describe_user_pool(UserPoolId=pool_id)["UserPool"]

            # 2. Preserve the existing LambdaConfig — critically including
            #    PreTokenGenerationConfig, written by set_pre_token_trigger.py —
            #    and add/override only the three challenge keys.
            lambda_config = dict(pool.get("LambdaConfig", {}))
            pre_token_before = lambda_config.get("PreTokenGenerationConfig")
            lambda_config.update(wanted)

            # 3. Re-apply: current settings preserved + triggers wired. Empty
            #    values are dropped rather than sent back, since some are
            #    rejected as explicit empties even though describe returns them
            #    that way.
            preserved = {
                field: pool[field]
                for field in PRESERVED_FIELDS
                if pool.get(field) not in (None, "", {}, [])
            }
            idp.update_user_pool(
                UserPoolId=pool_id, LambdaConfig=lambda_config, **preserved
            )

            # 4. Verify by RE-READING the pool, not by trusting that the call
            #    did not raise.
            wired = idp.describe_user_pool(UserPoolId=pool_id)["UserPool"].get(
                "LambdaConfig", {}
            )

            mismatches = [
                f"{key} (got '{wired.get(key, '')}', want '{arn}')"
                for key, arn in wanted.items()
                if wired.get(key) != arn
            ]

            # The pre-token trigger must have SURVIVED this PUT. Losing it drops
            # the app_user_id claim, which surfaces much later as an
            # authorization failure with no obvious link back to this script.
            pre_token_after = wired.get("PreTokenGenerationConfig")
            if pre_token_before and pre_token_after != pre_token_before:
                mismatches.append(
                    f"PreTokenGenerationConfig was not preserved "
                    f"(got '{pre_token_after}', want '{pre_token_before}')"
                )

            if mismatches:
                # Printed here, not in the handler, so the operator-facing
                # message and its stderr stream stay exactly as intended.
                print(
                    "set_auth_challenge_triggers.py: FAILED — "
                    + "; ".join(mismatches),
                    file=sys.stderr,
                )
                raise TriggersNotWired("; ".join(mismatches))
    except TriggersNotWired:
        return 1

    print(
        f"set_auth_challenge_triggers.py: wired DefineAuthChallenge, "
        f"CreateAuthChallenge and VerifyAuthChallengeResponse on {pool_id} "
        f"(existing pool settings and PreTokenGenerationConfig preserved)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
