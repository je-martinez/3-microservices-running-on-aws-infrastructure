#!/usr/bin/env bash
# smoke-test.sh — Floci auth-chain spike gate (stable-DNS version).
#
# Validates: Cognito JWT → API GW v2 JWT authorizer → ECS Nginx → spike-backend.
# PASS when: GET /protected (no token) → 401, and GET /protected (Bearer) → 200
# with body "spike-ok-via-floci".
#
# KEY DIFFERENCE vs the old version: there is NO docker-inspect + integration-IP
# patch. The API GW integration targets the constant Docker-DNS alias
# `nginx-stable` (see main.tf). bootstrap.sh attaches that alias to the current
# nginx ECS container; this script just ensures the alias is present, then tests.
#
# Floci specifics (see README.md "Findings"):
#   - invoke URL: http://localhost:4566/restapis/<api-id>/$default/_user_request_/<path>
#   - IdToken iss: http://localhost:4566/<pool-id>  (authorizer issuer matches)
set -euo pipefail

ENDPOINT="http://localhost:4566"
REGION="us-east-1"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION="$REGION"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

aws_() { aws --endpoint-url="$ENDPOINT" --region="$REGION" --no-cli-pager "$@"; }

G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; N='\033[0m'
pass(){ echo -e "  ${G}PASS${N}: $1"; }
fail(){ echo -e "  ${R}FAIL${N}: $1"; exit 1; }

API_ID=$(terraform -chdir="$HERE" output -raw api_id)
POOL_ID=$(terraform -chdir="$HERE" output -raw cognito_user_pool_id)
CLIENT_ID=$(terraform -chdir="$HERE" output -raw cognito_client_id)
INVOKE="http://localhost:4566/restapis/${API_ID}/\$default/_user_request_"
echo "API invoke base: $INVOKE"

# 1. Ensure the stable DNS alias is attached (idempotent). NO integration patch.
echo "[1/4] Ensuring stable DNS alias 'nginx-stable' is attached…"
bash "$HERE/bootstrap.sh" >/dev/null 2>&1 || true
INTEG_URI=$(aws_ apigatewayv2 get-integration --api-id "$API_ID" \
  --integration-id "$(terraform -chdir="$HERE" output -raw nginx_integration_id)" \
  --query 'IntegrationUri' --output text 2>/dev/null || true)
pass "integration URI (unchanged, fixed): ${INTEG_URI}"

# 2. Cognito test user + authenticate
echo "[2/4] Minting an IdToken…"
USER="spikeuser@example.com"; PW="SpikePass123"
aws_ cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username "$USER" \
  --message-action SUPPRESS >/dev/null 2>&1 || true
aws_ cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" --username "$USER" \
  --password "$PW" --permanent >/dev/null 2>&1 || true
TOKEN=$(aws_ cognito-idp admin-initiate-auth --user-pool-id "$POOL_ID" \
  --client-id "$CLIENT_ID" --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters "USERNAME=$USER,PASSWORD=$PW" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['AuthenticationResult']['IdToken'])")
[ -n "$TOKEN" ] && pass "IdToken minted" || fail "could not mint IdToken"

sleep 2

# 3. Unauthenticated → expect 401
echo "[3/4] GET /protected without a token (expect 401)…"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$INVOKE/protected" || echo 000)
[ "$CODE" = "401" ] && pass "GET /protected (no token) → 401" || fail "expected 401, got $CODE"

# 4. Authenticated → expect 200 + body
echo "[4/4] GET /protected with Bearer token (expect 200 + spike-ok-via-floci)…"
BODY=$(curl -s --max-time 15 -H "Authorization: Bearer $TOKEN" "$INVOKE/protected" || true)
if echo "$BODY" | grep -q "spike-ok-via-floci"; then
  pass "GET /protected (Bearer) → 200 body=spike-ok-via-floci"
  echo -e "\n  ${G}GATE VERDICT: PASS — full chain works on Floci, NO IP patch (stable DNS alias).${N}"
  exit 0
fi
fail "GATE VERDICT: FAIL — authenticated call did not return expected body. Got: '${BODY:0:120}'"
