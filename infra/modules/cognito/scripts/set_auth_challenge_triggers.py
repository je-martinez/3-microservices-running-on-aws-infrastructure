#!/usr/bin/env python3
"""Idempotent Cognito CUSTOM_AUTH trigger wiring via boto3.

Used ONLY by modules/cognito/main.tf's terraform_data.auth_challenge_triggers,
the same Floci-only workaround as terraform_data.pre_token_trigger
(set_pre_token_trigger.py): the AWS provider pinned at 5.31.0 (ADR-0016) cannot
express these LambdaConfig keys alongside the V2 pre-token config, so this
script registers them directly, outside Terraform's resource lifecycle.

Sets DefineAuthChallenge, CreateAuthChallenge, and VerifyAuthChallengeResponse
in ONE update_user_pool call. Three separate scripts (or three calls) would each
PUT the whole pool and clobber each other's LambdaConfig, leaving only the last
one wired.

All three ARNs are normally the SAME function — one Lambda dispatching on
event.triggerSource (otp-challenge-lambda/index.mjs). They are separate env vars
anyway so the three keys can be pointed at different functions later without a
change here.

SETTINGS-PRESERVING, same as set_pre_token_trigger.py ────────────────────────
UpdateUserPool is a PUT, not a PATCH. A call passing ONLY LambdaConfig would
reset every OTHER top-level pool setting (password Policies,
AutoVerifiedAttributes, AdminCreateUserConfig, ...) to service defaults — which
would silently re-tighten the intentionally relaxed local password policy and
break E2E signups. So this reads the current pool, keeps the fields
UpdateUserPool accepts, injects the three trigger keys, and re-applies it whole.

That preservation extends to LambdaConfig itself: the EXISTING
PreTokenGenerationConfig is carried through unchanged. Verified live that the
challenge triggers coexist with it — but only because it is copied forward.
Dropping it silently removes the app_user_id token claim, which fails as a
downstream authorization bug far from this script.

Schema/custom attributes are NOT re-passable via UpdateUserPool (create-only
plus add-custom-attributes) and are deliberately NOT touched, so
custom:app_user_id is safe.

Required env vars (set by the calling local-exec provisioner):
  USER_POOL_ID                              - Cognito User Pool id
  DEFINE_AUTH_CHALLENGE_LAMBDA_ARN          - ARN for the DefineAuthChallenge key
  CREATE_AUTH_CHALLENGE_LAMBDA_ARN          - ARN for the CreateAuthChallenge key
  VERIFY_AUTH_CHALLENGE_RESPONSE_LAMBDA_ARN - ARN for the VerifyAuthChallengeResponse key
  ENDPOINT_URL                              - optional endpoint override
  AWS_REGION                                - AWS region

Optional:
  EXECUTION_LOG_TABLE - DynamoDB table recording this run for traceability
                        (lib3mrai.execution_log). Unset = record nothing and
                        behave exactly as if the log did not exist; the log
                        never skips a run.
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
    """The post-update verification found one or more triggers absent/mismatched.

    Exists so the execution log can observe a verification failure: reporting it
    by RETURNING 1 is invisible to the wrapper (which detects failure only from
    an exception) and would be recorded as "ok" — a traceability log claiming a
    run succeeded when it did not. main() catches it and restores exit code 1.
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
