#!/usr/bin/env bash
# bootstrap.sh — attach a STABLE Docker-DNS alias to the nginx ECS container.
#
# Why this exists:
#   Floci launches the nginx ECS task as a Docker container whose name and IP
#   change on every `terraform apply` (the task is recreated). Instead of patching
#   the API Gateway integration URI with a volatile IP each run, we attach a
#   CONSTANT network alias (`nginx-stable`) to whatever nginx container is running.
#   The API GW integration in main.tf already points at http://nginx-stable/ , a
#   name that never changes. So the integration URI is correct at apply time,
#   Terraform state never drifts, and re-running just re-points the same alias.
#
#   Floci's Route53 is management-plane only (no resolution) and ECS tasks aren't
#   registered in Cloud Map, so a Docker-native alias is the working approach
#   (Docker embedded DNS at 127.0.0.11 resolves it, including from Floci's API GW
#   container).
#
# Unlike the spike (which proxied to a spike-backend echo returning
# "spike-ok-via-floci"), environments/local proxies to the REAL `users` service,
# whose health endpoint returns {"status":"ok"} at /v1/health. The verification
# step below checks that instead.
#
# Idempotent: safe to run repeatedly. Run it once after each `terraform apply`.
#
# Usage:
#   bash infra/environments/local/bootstrap.sh
set -euo pipefail

NETWORK="3mrai_3mrai-network"
ALIAS="${NGINX_STABLE_ALIAS:-nginx-stable}"
FIXED_IP="${NGINX_STABLE_IP:-192.168.155.20}"   # empty → alias only, keep auto IP

G='\033[0;32m'; R='\033[0;31m'; N='\033[0m'
ok(){ echo -e "  ${G}OK${N}: $1"; }
no(){ echo -e "  ${R}NO${N}: $1"; }
inf(){ echo -e "  $1"; }

echo "== bootstrap: stable DNS alias for the nginx ECS container =="

# 1. Find the nginx ECS container Floci launched.
NGINX=""
for i in $(seq 1 20); do
  NGINX=$(docker ps --format '{{.Names}}' | grep -iE "floci-ecs.*nginx" | head -1 || true)
  [ -n "$NGINX" ] && break
  inf "waiting for nginx ECS container (attempt $i/20)…"; sleep 3
done
[ -n "$NGINX" ] || { no "no nginx ECS container found. Is Floci up and 'terraform apply' done?"; exit 1; }
ok "nginx container: $NGINX"

# 2. If the alias already resolves to a running container, we're done (idempotent).
CURRENT=$(docker ps --filter "network=${NETWORK}" --format '{{.Names}}' | while read -r c; do
  als=$(docker inspect "$c" --format '{{range .NetworkSettings.Networks}}{{range .Aliases}}{{.}} {{end}}{{end}}' 2>/dev/null || true)
  echo "$als" | grep -qw "$ALIAS" && echo "$c"
done | head -1 || true)
if [ "$CURRENT" = "$NGINX" ]; then
  ok "alias '$ALIAS' already attached to the current nginx container — nothing to do."
  exit 0
fi

# 3. Re-attach the alias (and fixed IP) to the current nginx container.
#    Docker requires disconnect+connect to (re)set an alias/IP on an existing
#    network membership. Disconnect is a no-op-safe if already connected.
inf "attaching alias '$ALIAS'${FIXED_IP:+ and IP $FIXED_IP} on ${NETWORK} ..."
docker network disconnect "$NETWORK" "$NGINX" >/dev/null 2>&1 || true
if [ -n "$FIXED_IP" ]; then
  if ! docker network connect --alias "$ALIAS" --ip "$FIXED_IP" "$NETWORK" "$NGINX" 2>/tmp/bs_err; then
    no "fixed IP $FIXED_IP unavailable ($(cat /tmp/bs_err)); retrying alias-only…"
    docker network connect --alias "$ALIAS" "$NETWORK" "$NGINX"
  fi
else
  docker network connect --alias "$ALIAS" "$NETWORK" "$NGINX"
fi

# 4. Verify the alias resolves and proxies to the users service, from inside the
#    network. users /v1/health returns {"status":"ok"}.
sleep 1
BODY=$(docker exec "$NGINX" sh -c "wget -qO- --timeout=5 http://${ALIAS}/v1/health 2>/dev/null" || true)
if echo "$BODY" | grep -q '"status":"ok"'; then
  ok "alias '$ALIAS' resolves and proxies → users /v1/health {\"status\":\"ok\"}"
  echo ""
  echo "  API GW integration already targets http://${ALIAS}/ — no patch needed."
else
  no "alias attached but /v1/health did not return the expected body (got: '${BODY:0:80}')"
  inf "the users container may not be ready yet; re-run after it is up."
  exit 1
fi
