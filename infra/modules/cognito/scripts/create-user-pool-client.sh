#!/usr/bin/env bash
# create-user-pool-client.sh — idempotent Cognito App Client creation via awscli.
#
# Used ONLY by modules/cognito/main.tf's terraform_data.client_via_cli, which
# is gated by var.manage_client_via_provider = false (Floci local only — see
# that variable's description for why the native aws_cognito_user_pool_client
# resource cannot be used against Floci).
#
# Idempotent: if a client with CLIENT_NAME already exists under USER_POOL_ID,
# it is reused (its id is written to STATE_FILE) instead of creating a
# duplicate on every re-apply.
#
# Required env vars (set by the calling local-exec provisioner):
#   USER_POOL_ID  - Cognito User Pool id the client belongs to
#   CLIENT_NAME   - name of the App Client (used for idempotent lookup)
#   STATE_FILE    - path to write the resulting {"ClientId": "..."} JSON
#   ENDPOINT_URL  - optional --endpoint-url override (empty = default resolution)
#   AWS_REGION    - AWS region
set -euo pipefail

: "${USER_POOL_ID:?USER_POOL_ID is required}"
: "${CLIENT_NAME:?CLIENT_NAME is required}"
: "${STATE_FILE:?STATE_FILE is required}"
AWS_REGION="${AWS_REGION:-us-east-1}"

ENDPOINT_ARGS=()
if [ -n "${ENDPOINT_URL:-}" ]; then
  ENDPOINT_ARGS=(--endpoint-url "$ENDPOINT_URL")
fi

mkdir -p "$(dirname "$STATE_FILE")"

# 1. Idempotent lookup: reuse an existing client with the same name, if any.
EXISTING_ID=$(aws cognito-idp list-user-pool-clients \
  --user-pool-id "$USER_POOL_ID" \
  --region "$AWS_REGION" \
  --max-results 60 \
  "${ENDPOINT_ARGS[@]}" \
  --output json \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
for c in data.get('UserPoolClients', []):
    if c.get('ClientName') == '$CLIENT_NAME':
        print(c['ClientId'])
        break
")

if [ -n "$EXISTING_ID" ]; then
  echo "{\"ClientId\": \"${EXISTING_ID}\", \"UserPoolId\": \"${USER_POOL_ID}\"}" > "$STATE_FILE"
  echo "create-user-pool-client.sh: reused existing client '${CLIENT_NAME}' (${EXISTING_ID})"
  exit 0
fi

# 2. Create the client. Auth flows must match what the native resource sets
#    (modules/cognito/main.tf, aws_cognito_user_pool_client.this).
RESULT=$(aws cognito-idp create-user-pool-client \
  --user-pool-id "$USER_POOL_ID" \
  --client-name "$CLIENT_NAME" \
  --no-generate-secret \
  --explicit-auth-flows ALLOW_ADMIN_USER_PASSWORD_AUTH ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
  --region "$AWS_REGION" \
  "${ENDPOINT_ARGS[@]}" \
  --output json)

CLIENT_ID=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['UserPoolClient']['ClientId'])")

echo "{\"ClientId\": \"${CLIENT_ID}\", \"UserPoolId\": \"${USER_POOL_ID}\"}" > "$STATE_FILE"
echo "create-user-pool-client.sh: created client '${CLIENT_NAME}' (${CLIENT_ID})"
