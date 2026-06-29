#!/usr/bin/env bash
# =============================================================================
# bootstrap.sh — Local-only post-apply bootstrap for the Users chain
#
# Problem this solves (ADR-0016):
#   The Nginx ECS task's container IP on 3mrai_3mrai-network is not known at
#   `terraform apply` time. The API Gateway HTTP_PROXY integration is created
#   with a placeholder URI (http://0.0.0.0:80/). After the ECS task launches,
#   this script:
#     1. Discovers the Nginx container IP via `docker inspect`.
#     2. Patches the API Gateway integration URI using `aws apigatewayv2
#        update-integration` (direct AWS CLI call — idempotent).
#     3. Validates the patch by reading the integration back.
#
# Why direct AWS CLI instead of re-applying Terraform:
#   Re-applying with -var nginx_container_ip=<ip> also works, but requires a
#   full plan cycle (slow) and leaves a variable value in tfvars. The direct
#   AWS CLI patch is faster and avoids state drift when the IP changes across
#   restarts. Run `terraform apply -var nginx_container_ip=<ip>` if you need
#   the state to reflect the real IP (e.g. for `terraform show`).
#
# Idempotency:
#   `update-integration` is idempotent — running this script multiple times
#   is safe; each run re-patches the integration to the current Nginx IP.
#
# Prerequisites:
#   - Ministack is running and healthy (docker compose up -d ministack)
#   - `terraform apply` has already been run in this directory
#   - AWS CLI v2, docker CLI, python3 (or jq) available
#
# Usage:
#   bash infra/environments/local/bootstrap.sh
#
# What follows (outside this script):
#   1. Run the Prisma migration:
#        export DATABASE_WRITER_URL=$(terraform -chdir=infra/environments/local output -raw database_writer_url)
#        nvm use && pnpm --filter @3mrai/users prisma migrate deploy
#   2. Export Cognito IDs for the users container (if not already in .env):
#        export COGNITO_USER_POOL_ID=$(terraform -chdir=infra/environments/local output -raw cognito_user_pool_id)
#        export COGNITO_CLIENT_ID=$(terraform -chdir=infra/environments/local output -raw cognito_client_id)
#   3. Start the users service: docker compose up -d users
#   4. Verify: curl http://<api-id>.execute-api.localhost:4566/v1/health → 200
# =============================================================================
set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

MINISTACK_ENDPOINT="http://localhost:4566"
REGION="us-east-1"
COMPOSE_NETWORK="3mrai_3mrai-network"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export AWS_ACCESS_KEY_ID="test"
export AWS_SECRET_ACCESS_KEY="test"
export AWS_DEFAULT_REGION="${REGION}"

AWS_CLI="aws --endpoint-url=${MINISTACK_ENDPOINT} --region=${REGION} --no-cli-pager"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "  ${CYAN}INFO${NC}: $1"; }
pass()  { echo -e "  ${GREEN}PASS${NC}: $1"; }
fail()  { echo -e "  ${RED}FAIL${NC}: $1"; exit 1; }
warn()  { echo -e "  ${YELLOW}WARN${NC}: $1"; }

echo "================================================================"
echo "  bootstrap.sh — Users chain on Ministack (JE-36)"
echo "  Topology: API GW → Nginx ECS → users:3000"
echo "================================================================"

# ─── Step 1: Read Terraform outputs ──────────────────────────────────────────
echo ""
echo "[1/5] Reading Terraform outputs from ${SCRIPT_DIR}..."

API_ID=$(terraform -chdir="${SCRIPT_DIR}" output -raw api_id 2>/dev/null) || \
  fail "Could not read api_id from Terraform outputs. Did you run 'terraform apply'?"

INTEGRATION_ID=$(terraform -chdir="${SCRIPT_DIR}" output -raw integration_id 2>/dev/null) || \
  fail "Could not read integration_id. Did you run 'terraform apply'?"

info "API Gateway ID   : ${API_ID}"
info "Integration ID   : ${INTEGRATION_ID}"
info "Local invoke URL : http://${API_ID}.execute-api.localhost:4566"

# ─── Step 2: Discover Nginx ECS container IP ─────────────────────────────────
echo ""
echo "[2/5] Discovering Nginx ECS container IP on ${COMPOSE_NETWORK}..."

# Ministack names ECS task containers: ministack-ecs-<task-id>-<container-name>
# Wait up to 60 s for the nginx container to appear after apply.
#
# Selection strategy (guards against multiple nginx ECS containers when a spike
# or previous environment is still running):
#   1. Ask ECS for the running task ARN in the JE-36 cluster
#      (3mrai-local-users-cluster / 3mrai-local-users-nginx).
#   2. Extract the short task-id from the ARN (last path component, first 8 chars).
#   3. Match docker containers whose name contains "ministack-ecs-<task-id>".
#   4. Among those, keep only the one whose nginx config proxies to "users"
#      (extra safety — rejects any leftover spike containers with the same task-id).
#   If ECS cannot return a task ARN yet, fall back to the proxy-config check only.
NGINX_ID=""
NGINX_IP=""
MAX_ATTEMPTS=20

ECS_CLUSTER="3mrai-local-users-cluster"
ECS_SERVICE="3mrai-local-users-nginx"

for i in $(seq 1 ${MAX_ATTEMPTS}); do
  # Step 2a: resolve the running task id from the JE-36 ECS service
  TASK_ARN=$(${AWS_CLI} ecs list-tasks \
    --cluster "${ECS_CLUSTER}" \
    --service-name "${ECS_SERVICE}" \
    --desired-status RUNNING \
    2>/dev/null \
    | python3 -c "import sys,json; arns=json.load(sys.stdin).get('taskArns',[]); print(arns[0] if arns else '')" 2>/dev/null || true)

  # Ministack task ID is the UUID after the last '/'; take the first 8 chars.
  TASK_SHORT=""
  if [[ -n "${TASK_ARN}" ]]; then
    TASK_SHORT=$(echo "${TASK_ARN}" | awk -F'/' '{print $NF}' | cut -c1-8)
  fi

  # Step 2b: find the docker container that matches the task-id prefix
  if [[ -n "${TASK_SHORT}" ]]; then
    NGINX_ID=$(docker ps \
      --filter "name=ministack-ecs-${TASK_SHORT}" \
      --format "{{.ID}} {{.Names}}" 2>/dev/null \
      | grep -i "nginx" | awk '{print $1}' | head -1 || true)
  fi

  # Step 2c: fallback — if no task ARN yet, scan all ministack nginx containers
  # and pick the one whose config proxies to "users" (not spike-backend)
  if [[ -z "${NGINX_ID}" ]]; then
    while IFS= read -r line; do
      CID=$(echo "${line}" | awk '{print $1}')
      CNAME=$(echo "${line}" | awk '{print $2}')
      if [[ -n "${CID}" ]]; then
        BACKEND_CFG=$(docker exec "${CNAME}" \
          grep -r "proxy_pass" /etc/nginx/conf.d/ 2>/dev/null | grep "users" || true)
        if [[ -n "${BACKEND_CFG}" ]]; then
          NGINX_ID="${CID}"
          break
        fi
      fi
    done < <(docker ps \
      --filter "name=ministack-ecs" \
      --format "{{.ID}} {{.Names}}" 2>/dev/null \
      | grep -i "nginx" || true)
  fi

  if [[ -n "${NGINX_ID}" ]]; then
    # Prefer IP on the 3mrai network; fall back to the first IP found
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

  if [[ ${i} -lt ${MAX_ATTEMPTS} ]]; then
    info "Waiting for Nginx ECS container (attempt ${i}/${MAX_ATTEMPTS})..."
    sleep 3
  fi
done

if [[ -z "${NGINX_ID}" || -z "${NGINX_IP}" ]]; then
  fail "Could not find Nginx ECS container after ${MAX_ATTEMPTS} attempts.
  Check: docker ps | grep ministack-ecs
  If the ECS service failed to start, check Ministack logs: docker logs ministack"
fi

NGINX_NAME=$(docker inspect "${NGINX_ID}" --format "{{.Name}}" 2>/dev/null | tr -d '/')
info "Nginx container : ${NGINX_NAME} (${NGINX_ID})"
info "Nginx IP        : ${NGINX_IP}"

# ─── Step 3: Verify network reachability from Nginx container ────────────────
echo ""
echo "[3/5] Verifying Nginx can reach users:3000 via Docker DNS..."

DNS_CHECK=$(docker exec "${NGINX_NAME}" \
  curl -s --max-time 5 "http://users:3000/v1/health" 2>/dev/null || true)

if echo "${DNS_CHECK}" | grep -q '"status"'; then
  pass "Nginx → users:3000/v1/health reachable (body: ${DNS_CHECK})"
else
  warn "Nginx could not reach users:3000/v1/health (body: '${DNS_CHECK}')"
  warn "The users container may not be running yet."
  warn "Start it with: docker compose up -d users"
  warn "Continuing bootstrap — integration URI will still be patched."
fi

# ─── Step 4: Patch API Gateway integration URI ───────────────────────────────
echo ""
echo "[4/5] Patching API GW integration → http://${NGINX_IP}:80/ ..."

${AWS_CLI} apigatewayv2 update-integration \
  --api-id "${API_ID}" \
  --integration-id "${INTEGRATION_ID}" \
  --integration-uri "http://${NGINX_IP}:80/" \
  > /dev/null

pass "Integration URI patched to http://${NGINX_IP}:80/"

# Verify the patch was applied
PATCHED_URI=$(${AWS_CLI} apigatewayv2 get-integration \
  --api-id "${API_ID}" \
  --integration-id "${INTEGRATION_ID}" \
  2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('IntegrationUri',''))" 2>/dev/null || true)

if [[ "${PATCHED_URI}" == "http://${NGINX_IP}:80/" ]]; then
  pass "Integration URI confirmed: ${PATCHED_URI}"
else
  warn "Integration URI in API GW shows: '${PATCHED_URI}' (expected http://${NGINX_IP}:80/)"
fi

# ─── Step 5: Smoke check through the API Gateway ─────────────────────────────
echo ""
echo "[5/5] Smoke check: GET /v1/health through API Gateway..."

LOCAL_INVOKE_URL="http://${API_ID}.execute-api.localhost:4566"

# Wait a moment for Ministack to propagate the integration patch
sleep 2

HEALTH_STATUS=$(curl -s -o /tmp/health_body.txt -w "%{http_code}" \
  "${LOCAL_INVOKE_URL}/v1/health" --max-time 15 2>/dev/null || echo "000")
HEALTH_BODY=$(cat /tmp/health_body.txt 2>/dev/null || true)
rm -f /tmp/health_body.txt

echo "  HTTP status  : ${HEALTH_STATUS}"
echo "  Response body: ${HEALTH_BODY}"

if [[ "${HEALTH_STATUS}" == "200" ]]; then
  pass "GET /v1/health → 200 (full chain: API GW → Nginx → users:3000)"
else
  warn "GET /v1/health returned ${HEALTH_STATUS} (body: '${HEALTH_BODY}')"
  warn "The full chain is not yet healthy. Possible causes:"
  warn "  - users container not running: docker compose up -d users"
  warn "  - Prisma migration not run: see next steps below"
  warn "  - Nginx container not yet accepting connections: wait ~5s and retry"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "================================================================"
echo -e "  Bootstrap complete."
echo ""
echo "  API Gateway ID    : ${API_ID}"
echo "  Integration URI   : http://${NGINX_IP}:80/"
echo "  Local invoke URL  : ${LOCAL_INVOKE_URL}"
echo ""
echo "  Next steps:"
echo "  1. Run Prisma migration (from repo root):"
echo "       export DATABASE_WRITER_URL=\$(terraform -chdir=infra/environments/local output -raw database_writer_url)"
echo "       nvm use && pnpm --filter @3mrai/users prisma migrate deploy"
echo ""
echo "  2. Ensure users container is up:"
echo "       export COGNITO_USER_POOL_ID=\$(terraform -chdir=infra/environments/local output -raw cognito_user_pool_id)"
echo "       export COGNITO_CLIENT_ID=\$(terraform -chdir=infra/environments/local output -raw cognito_client_id)"
echo "       docker compose up -d users"
echo ""
echo "  3. Verify the full chain:"
echo "       curl ${LOCAL_INVOKE_URL}/v1/health"
echo "       Expected: {\"status\":\"ok\"}"
echo "================================================================"
