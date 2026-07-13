#!/usr/bin/env bash
# set-pre-token-trigger.sh — idempotent Cognito Pre-Token-Generation V2 trigger
# wiring via awscli.
#
# Used ONLY by modules/cognito/main.tf's terraform_data.pre_token_trigger, a
# Floci-only awscli workaround (same pattern as terraform_data.client_via_cli
# / create-user-pool-client.sh): the AWS provider is pinned to 5.31.0 (ADR-0016),
# whose aws_cognito_user_pool `lambda_config` block has no
# `pre_token_generation_config` sub-block, so the V2 trigger cannot be declared
# natively at that provider version. This script registers it directly via the
# AWS CLI, outside Terraform's resource lifecycle.
#
# Idempotent: it is a declarative `update-user-pool` call, so re-running it with
# the same USER_POOL_ID/LAMBDA_ARN yields the same pool state.
#
# SETTINGS-PRESERVING: `UpdateUserPool` is a PUT, not a PATCH — a call that
# passes ONLY --lambda-config would reset every OTHER top-level pool setting
# (password Policies, AutoVerifiedAttributes, AdminCreateUserConfig, …) to
# service defaults. That would silently re-tighten the intentionally relaxed
# local password policy. So this script first reads the current pool via
# describe-user-pool, keeps the fields UpdateUserPool accepts, injects the V2
# LambdaConfig, and re-applies the whole thing. (Schema/custom attributes are
# NOT re-passable via update-user-pool — they are create-only + add-custom-
# attributes — and are also NOT touched here, so custom:app_user_id is safe.)
#
# Required env vars (set by the calling local-exec provisioner):
#   USER_POOL_ID  - Cognito User Pool id to wire the trigger on
#   LAMBDA_ARN    - ARN of the Pre-Token-Generation V2 Lambda
#   ENDPOINT_URL  - optional --endpoint-url override (empty = default resolution)
#   AWS_REGION    - AWS region
set -euo pipefail

: "${USER_POOL_ID:?USER_POOL_ID is required}"
: "${LAMBDA_ARN:?LAMBDA_ARN is required}"
AWS_REGION="${AWS_REGION:-us-east-1}"

ENDPOINT_ARGS=()
if [ -n "${ENDPOINT_URL:-}" ]; then
  ENDPOINT_ARGS=(--endpoint-url "$ENDPOINT_URL")
fi

# Steps 1–3 are done in one Python block: it reads the current pool, keeps the
# settings UpdateUserPool accepts, injects the Pre-Token V2 LambdaConfig, and
# runs update-user-pool itself (via subprocess) — avoiding fragile argv passing
# between Python and bash 3.2 (macOS's default shell, which the local-exec
# interpreter resolves to). Schema/custom attributes are create-only and are
# deliberately NOT re-passed, so custom:app_user_id is untouched.
USER_POOL_ID="$USER_POOL_ID" LAMBDA_ARN="$LAMBDA_ARN" AWS_REGION="$AWS_REGION" \
ENDPOINT_URL="${ENDPOINT_URL:-}" python3 <<'PY'
import json, os, subprocess, sys

pool_id     = os.environ["USER_POOL_ID"]
lambda_arn  = os.environ["LAMBDA_ARN"]
region      = os.environ["AWS_REGION"]
endpoint    = os.environ.get("ENDPOINT_URL", "")
endpoint_args = ["--endpoint-url", endpoint] if endpoint else []

def aws(*args):
    return subprocess.run(
        ["aws", "cognito-idp", *args, "--region", region, *endpoint_args],
        check=True, capture_output=True, text=True,
    )

# 1. Read the current pool.
pool = json.loads(aws("describe-user-pool", "--user-pool-id", pool_id).stdout)["UserPool"]

# 2. Preserve existing LambdaConfig, add/override the Pre-Token V2 trigger.
lambda_config = dict(pool.get("LambdaConfig", {}))
lambda_config["PreTokenGenerationConfig"] = {"LambdaVersion": "V2_0", "LambdaArn": lambda_arn}

# Fields describe-user-pool returns that update-user-pool also accepts. Schema is
# NOT here on purpose (create-only). Value flags take JSON; the scalar-list and
# scalar flags take plain values.
JSON_FLAGS = {
    "Policies": "--policies",
    "VerificationMessageTemplate": "--verification-message-template",
    "UserAttributeUpdateSettings": "--user-attribute-update-settings",
    "DeviceConfiguration": "--device-configuration",
    "EmailConfiguration": "--email-configuration",
    "SmsConfiguration": "--sms-configuration",
    "UserPoolTags": "--user-pool-tags",
    "AdminCreateUserConfig": "--admin-create-user-config",
    "UserPoolAddOns": "--user-pool-add-ons",
    "AccountRecoverySetting": "--account-recovery-setting",
}
SCALAR_FLAGS = {
    "DeletionProtection": "--deletion-protection",
    "MfaConfiguration": "--mfa-configuration",
    "SmsAuthenticationMessage": "--sms-authentication-message",
}

args = ["update-user-pool", "--user-pool-id", pool_id]
for key, flag in JSON_FLAGS.items():
    if pool.get(key) not in (None, {}, []):
        args += [flag, json.dumps(pool[key])]
for key, flag in SCALAR_FLAGS.items():
    if pool.get(key) not in (None, ""):
        args += [flag, pool[key]]
if pool.get("AutoVerifiedAttributes"):
    args += ["--auto-verified-attributes", *pool["AutoVerifiedAttributes"]]
args += ["--lambda-config", json.dumps(lambda_config)]

# 3. Re-apply: current settings preserved + trigger wired.
aws(*args)
PY

# 4. Verify the trigger landed (independent confirmation, not just exit code).
GOT=$(aws cognito-idp describe-user-pool \
  --user-pool-id "$USER_POOL_ID" \
  --region "$AWS_REGION" \
  "${ENDPOINT_ARGS[@]}" \
  --output json \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["UserPool"].get("LambdaConfig",{}).get("PreTokenGenerationConfig",{}).get("LambdaArn",""))')
if [ "$GOT" != "$LAMBDA_ARN" ]; then
  echo "set-pre-token-trigger.sh: FAILED — trigger not wired (got '${GOT}', want '${LAMBDA_ARN}')" >&2
  exit 1
fi

echo "set-pre-token-trigger.sh: wired Pre-Token-Generation V2 trigger on ${USER_POOL_ID} -> ${LAMBDA_ARN} (existing pool settings preserved)"
