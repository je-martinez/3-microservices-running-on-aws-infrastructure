#!/usr/bin/env bash
# smoke-test.sh — Ministack auth-chain spike v2 smoke test
#
# Validates the REAL local topology:
#   Cognito JWT → API GW JWT authorizer → ECS Nginx (reverse proxy) → spike-backend
#
# Full chain proven when:
#   GET /protected (no token)   → 401
#   GET /protected (Bearer JWT) → 200  body: spike-ok-via-nginx
#
# The body "spike-ok-via-nginx" (set on spike-backend via http-echo -text flag)
# confirms traffic traversed: API GW → Nginx ECS task → spike-backend container.
#
# Steps:
#   0. Verify spike-backend is running on 3mrai_3mrai-network (start if needed).
#   1. Read Terraform outputs (pool ID, client ID, API ID, integration ID).
#   2. Discover the Nginx ECS container IP via docker inspect.
#   3. Update the API GW integration URI to http://<nginx-ip>:80/.
#   4. Verify: docker exec into Nginx container → curl spike-backend by name.
#   5. Create Cognito test user + authenticate (ADMIN_USER_PASSWORD_AUTH).
#   6. Unauthenticated call → expect 401.
#   7. Authenticated call → expect 200, body must contain "spike-ok-via-nginx".
#
# Ministack quirks:
#   - API GW invoke_url uses real AWS domain; local URL is
#     http://<api-id>.execute-api.localhost:4566
#   - Cognito JWT iss = https://cognito-idp.us-east-1.amazonaws.com/<pool-id>
#   - No ALB: API GW integration points directly to Nginx container IP
#   - Nginx container IP is discovered post-launch via docker inspect
#   - AWS provider pinned to 5.31.0 (v5.100 crashes Ministack)
#
# Prerequisites:
#   - docker compose up -d (Ministack healthy)
#   - terraform apply already run in this directory
#   - AWS CLI v2, docker CLI
#
# Exit codes: 0 = PASS, non-zero = FAIL
set -euo pipefail

# ------------------------------------------------------------------ #
# Config
# ------------------------------------------------------------------ #
MINISTACK_ENDPOINT="http://localhost:4566"
REGION="us-east-1"
AWS_CLI="aws --endpoint-url=${MINISTACK_ENDPOINT} --region=${REGION} --no-cli-pager"
export AWS_ACCESS_KEY_ID="test"
export AWS_SECRET_ACCESS_KEY="test"
export AWS_DEFAULT_REGION="${REGION}"

COMPOSE_NETWORK="3mrai_3mrai-network"
SPIKE_BACKEND_NAME="spike-backend"
SPIKE_BACKEND_PORT="8080"
SPIKE_BACKEND_TEXT="spike-ok-via-nginx"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC}: $1"; }
fail() { echo -e "${RED}FAIL${NC}: $1"; exit 1; }
info() { echo -e "  ${YELLOW}INFO${NC}: $1"; }

echo "======================================================"
echo "  Ministack auth-chain spike v2 (JE-25)"
echo "  Topology: API GW → Nginx ECS → spike-backend"
echo "======================================================"

# ------------------------------------------------------------------ #
# Step 0: Ensure spike-backend is running on the compose network
# ------------------------------------------------------------------ #
echo ""
echo "[0/7] Checking spike-backend container..."

BACKEND_ID=$(docker ps --filter "name=${SPIKE_BACKEND_NAME}" --format "{{.ID}}" 2>/dev/null | head -1 || true)

if [[ -z "${BACKEND_ID}" ]]; then
  info "spike-backend not found — starting it now..."
  docker run -d \
    --name "${SPIKE_BACKEND_NAME}" \
    --network "${COMPOSE_NETWORK}" \
    hashicorp/http-echo:latest \
    "-listen=:${SPIKE_BACKEND_PORT}" \
    "-text=${SPIKE_BACKEND_TEXT}" \
    > /dev/null
  sleep 2
  BACKEND_ID=$(docker ps --filter "name=${SPIKE_BACKEND_NAME}" --format "{{.ID}}" 2>/dev/null | head -1 || true)
  if [[ -z "${BACKEND_ID}" ]]; then
    fail "Failed to start spike-backend container."
  fi
  info "spike-backend started (id=${BACKEND_ID})"
else
  info "spike-backend already running (id=${BACKEND_ID})"
fi

BACKEND_IP=$(docker inspect "${BACKEND_ID}" \
  --format "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" 2>/dev/null | head -c 20 || true)
echo "  spike-backend IP: ${BACKEND_IP}"

# ------------------------------------------------------------------ #
# Step 1: Read Terraform outputs
# ------------------------------------------------------------------ #
echo ""
echo "[1/7] Reading Terraform outputs..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

POOL_ID=$(terraform -chdir="${SCRIPT_DIR}" output -raw cognito_user_pool_id 2>/dev/null)
CLIENT_ID=$(terraform -chdir="${SCRIPT_DIR}" output -raw cognito_client_id 2>/dev/null)
INTEGRATION_ID=$(terraform -chdir="${SCRIPT_DIR}" output -raw nginx_integration_id 2>/dev/null)

if [[ -z "${POOL_ID}" || -z "${CLIENT_ID}" || -z "${INTEGRATION_ID}" ]]; then
  fail "Could not read Terraform outputs. Did you run 'terraform apply' in ${SCRIPT_DIR}?"
fi

# Ministack quirk: invoke_url is a real AWS domain; derive local URL from API ID.
API_ID=$(terraform -chdir="${SCRIPT_DIR}" output -raw api_invoke_url 2>/dev/null \
  | grep -oE '[a-z0-9]{8}\.execute-api' | cut -d. -f1 || echo "")
if [[ -z "${API_ID}" ]]; then
  API_ID=$(${AWS_CLI} apigatewayv2 get-apis 2>/dev/null \
    | python3 -c "
import sys,json
items=json.load(sys.stdin).get('Items',[])
apis=[i for i in items if i.get('Name')=='3mrai-local-spike-api']
print(apis[0]['ApiId'] if apis else '')
" 2>/dev/null)
fi

if [[ -z "${API_ID}" ]]; then
  fail "Could not determine API Gateway ID."
fi

LOCAL_INVOKE_URL="http://${API_ID}.execute-api.localhost:4566"

echo "  User Pool ID   : ${POOL_ID}"
echo "  Client ID      : ${CLIENT_ID}"
echo "  API ID         : ${API_ID}"
echo "  Integration ID : ${INTEGRATION_ID}"
echo "  Local URL      : ${LOCAL_INVOKE_URL}"

# ------------------------------------------------------------------ #
# Step 2: Discover Nginx ECS container IP
# ------------------------------------------------------------------ #
echo ""
echo "[2/7] Discovering Nginx ECS container IP..."

# Ministack names ECS task containers: ministack-ecs-<task-id>-<container-name>
# We wait up to 30 s for the nginx container to appear after terraform apply.
NGINX_ID=""
NGINX_IP=""
for i in $(seq 1 10); do
  NGINX_ID=$(docker ps \
    --filter "name=ministack-ecs" \
    --format "{{.ID}} {{.Names}}" 2>/dev/null \
    | grep "nginx" | awk '{print $1}' | head -1 || true)
  if [[ -n "${NGINX_ID}" ]]; then
    # Prefer the IP on 3mrai_3mrai-network; strip any trailing whitespace/newlines
    NGINX_IP=$(docker inspect "${NGINX_ID}" \
      --format '{{range $net, $cfg := .NetworkSettings.Networks}}{{$net}}={{$cfg.IPAddress}}|{{end}}' \
      2>/dev/null | tr '|' '\n' | grep "3mrai" | cut -d= -f2 | head -1 | tr -d '[:space:]' || true)
    if [[ -z "${NGINX_IP}" ]]; then
      NGINX_IP=$(docker inspect "${NGINX_ID}" \
        --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}|{{end}}' 2>/dev/null \
        | tr '|' '\n' | grep -v '^$' | head -1 | tr -d '[:space:]')
    fi
    [[ -n "${NGINX_IP}" ]] && break
  fi
  info "Waiting for Nginx ECS container (attempt ${i}/10)..."
  sleep 3
done

if [[ -z "${NGINX_IP}" || -z "${NGINX_ID}" ]]; then
  fail "Could not find Nginx ECS container. Is the ECS service running? Check: docker ps | grep ministack-ecs"
fi

NGINX_NAME=$(docker inspect "${NGINX_ID}" --format "{{.Name}}" 2>/dev/null | tr -d '/')
echo "  Nginx container : ${NGINX_NAME}"
echo "  Nginx IP        : ${NGINX_IP}"

# ------------------------------------------------------------------ #
# Step 3: Update API GW integration URI to Nginx container IP
# ------------------------------------------------------------------ #
echo ""
echo "[3/7] Updating API GW integration URI → http://${NGINX_IP}:80/ ..."

${AWS_CLI} apigatewayv2 update-integration \
  --api-id "${API_ID}" \
  --integration-id "${INTEGRATION_ID}" \
  --integration-uri "http://${NGINX_IP}:80/" \
  > /dev/null

echo "  Integration URI updated."

# ------------------------------------------------------------------ #
# Step 4: Verify DNS resolution from inside the Nginx container
# ------------------------------------------------------------------ #
echo ""
echo "[4/7] DNS verification: curl http://spike-backend from inside Nginx container..."

# Try curl first (available in nginx:alpine); fall back to wget
DNS_BODY=$(docker exec "${NGINX_NAME}" \
  curl -s --max-time 5 "http://spike-backend:${SPIKE_BACKEND_PORT}/" \
  2>/dev/null || true)

if [[ -z "${DNS_BODY}" ]]; then
  DNS_BODY=$(docker exec "${NGINX_NAME}" \
    wget -q -O - "http://spike-backend:${SPIKE_BACKEND_PORT}/" \
    2>/dev/null || true)
fi

echo "  DNS check body: '${DNS_BODY}'"

if echo "${DNS_BODY}" | grep -q "${SPIKE_BACKEND_TEXT}"; then
  pass "Nginx container resolved 'spike-backend' by Docker DNS and got expected body"
else
  info "DNS resolution failed or body mismatch — running nslookup..."
  docker exec "${NGINX_NAME}" nslookup spike-backend 2>&1 || true
  fail "Nginx container could NOT reach spike-backend by service name. DNS resolution failed on 3mrai_3mrai-network."
fi

# ------------------------------------------------------------------ #
# Step 5: Create Cognito user and authenticate
# ------------------------------------------------------------------ #
SPIKE_USER="smoke-test@example.com"
SPIKE_PASS="SmokeTest123!"

echo ""
echo "[5/7] Creating Cognito test user (${SPIKE_USER})..."
${AWS_CLI} cognito-idp admin-create-user \
  --user-pool-id "${POOL_ID}" \
  --username "${SPIKE_USER}" \
  --message-action SUPPRESS \
  --user-attributes \
    Name=email,Value="${SPIKE_USER}" \
    Name=email_verified,Value=true \
  > /dev/null 2>&1 || true   # idempotent

${AWS_CLI} cognito-idp admin-set-user-password \
  --user-pool-id "${POOL_ID}" \
  --username "${SPIKE_USER}" \
  --password "${SPIKE_PASS}" \
  --permanent \
  > /dev/null 2>&1 || true   # idempotent

AUTH_RESULT=$(${AWS_CLI} cognito-idp admin-initiate-auth \
  --user-pool-id "${POOL_ID}" \
  --client-id "${CLIENT_ID}" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters "USERNAME=${SPIKE_USER},PASSWORD=${SPIKE_PASS}" \
  2>&1)

ID_TOKEN=$(echo "${AUTH_RESULT}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d['AuthenticationResult']['IdToken'])
" 2>/dev/null || true)

if [[ -z "${ID_TOKEN}" ]]; then
  echo "  Auth response: ${AUTH_RESULT}"
  fail "Could not extract IdToken from authentication response."
fi
echo "  IdToken obtained (length=${#ID_TOKEN})"

# ------------------------------------------------------------------ #
# Step 6: Unauthenticated call — expect 401
# ------------------------------------------------------------------ #
echo ""
echo "[6/7] Unauthenticated call to GET /protected (expect 401)..."
UNAUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  "${LOCAL_INVOKE_URL}/protected" \
  --max-time 15 2>/dev/null || echo "000")
echo "  HTTP status: ${UNAUTH_STATUS}"

if [[ "${UNAUTH_STATUS}" == "401" ]]; then
  pass "Unauthenticated call returned 401"
else
  fail "Expected 401 for unauthenticated call, got ${UNAUTH_STATUS}."
fi

# ------------------------------------------------------------------ #
# Step 7: Authenticated call — expect 200 + spike-backend body
# ------------------------------------------------------------------ #
echo ""
echo "[7/7] Authenticated call to GET /protected with Bearer token (expect 200)..."
AUTH_BODY_FILE=$(mktemp)
AUTH_STATUS=$(curl -s -o "${AUTH_BODY_FILE}" -w "%{http_code}" \
  "${LOCAL_INVOKE_URL}/protected" \
  -H "Authorization: Bearer ${ID_TOKEN}" \
  --max-time 15 2>/dev/null || echo "000")

BODY=$(cat "${AUTH_BODY_FILE}" 2>/dev/null || true)
rm -f "${AUTH_BODY_FILE}"

echo "  HTTP status  : ${AUTH_STATUS}"
echo "  Response body: ${BODY}"

if [[ "${AUTH_STATUS}" != "200" ]]; then
  fail "Expected 200 for authenticated call, got ${AUTH_STATUS}."
fi

if ! echo "${BODY}" | grep -q "${SPIKE_BACKEND_TEXT}"; then
  fail "200 received but body '${BODY}' does not contain '${SPIKE_BACKEND_TEXT}'. Traffic may not have traversed Nginx → spike-backend."
fi

pass "Authenticated call returned 200 with spike-backend body"

# ------------------------------------------------------------------ #
# Gate verdict
# ------------------------------------------------------------------ #
echo ""
echo "======================================================"
echo -e "  ${GREEN}GATE VERDICT: PASS${NC}"
echo "  Unauth = 401   Auth = 200"
echo "  Body: ${BODY}"
echo "  Full chain: API GW → JWT authorizer → Nginx (ECS) → spike-backend"
echo ""
echo "  Proven config (port to JE-28/JE-30):"
echo "    JWT issuer   : https://cognito-idp.us-east-1.amazonaws.com/${POOL_ID}"
echo "    Audience     : ${CLIENT_ID}"
echo "    Auth flow    : ADMIN_USER_PASSWORD_AUTH"
echo "    Nginx IP     : ${NGINX_IP}  (ECS container on ${COMPOSE_NETWORK})"
echo "    proxy_pass   : http://spike-backend:${SPIKE_BACKEND_PORT}  (Docker DNS)"
echo "    API GW URL   : ${LOCAL_INVOKE_URL}"
echo "======================================================"
