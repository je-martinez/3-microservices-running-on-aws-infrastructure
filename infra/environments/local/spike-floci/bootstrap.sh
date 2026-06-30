#!/usr/bin/env bash
# bootstrap.sh — attach a STABLE Docker-DNS alias to the nginx ECS container.
#
# Why this exists (and why it is better than the old IP-patch bootstrap):
#   Floci launches the nginx ECS task as a Docker container whose name and IP
#   change on every `terraform apply` (the task is recreated). The old approach
#   discovered that volatile IP via `docker inspect` and PATCHED the API Gateway
#   integration each run (mutating Terraform-managed infra).
#
#   Instead, this script attaches a CONSTANT network alias (`nginx-stable`) — and
#   optionally a fixed IP — to whatever nginx container is currently running. The
#   API GW integration in main.tf already points at http://nginx-stable/ , a name
#   that NEVER changes. So:
#     - the integration URI is correct at apply time (no post-apply patch),
#     - Terraform state never drifts from an out-of-band IP change,
#     - re-running after a task recreation just re-points the same alias.
#
#   This is the local "stable DNS" / mock-Route53 mechanism: Floci's Route53 is
#   management-plane only (no resolution) and ECS tasks aren't registered in Cloud
#   Map, so a Docker-native alias is the working approach (Docker embedded DNS at
#   127.0.0.11 resolves it, including from Floci's API GW container — verified).
#
# Idempotent: safe to run repeatedly. Run it once after each `terraform apply`.
#
# Usage:
#   bash infra/environments/local/spike-floci/bootstrap.sh
set -euo pipefail

NETWORK="3mrai_3mrai-network"
ALIAS="${NGINX_STABLE_ALIAS:-nginx-stable}"
FIXED_IP="${NGINX_STABLE_IP:-192.168.155.20}"   # empty → alias only, keep auto IP

G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; N='\033[0m'
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
    # Fixed IP may be taken (e.g. by a stale container). Fall back to alias-only.
    no "fixed IP $FIXED_IP unavailable ($(cat /tmp/bs_err)); retrying alias-only…"
    docker network connect --alias "$ALIAS" "$NETWORK" "$NGINX"
  fi
else
  docker network connect --alias "$ALIAS" "$NETWORK" "$NGINX"
fi

# 4. Verify the alias resolves and proxies, from inside the network.
sleep 1
BODY=$(docker exec "$NGINX" sh -c "wget -qO- --timeout=5 http://${ALIAS}/ 2>/dev/null" || true)
if echo "$BODY" | grep -q "spike-ok-via-floci"; then
  ok "alias '$ALIAS' resolves and proxies → spike-ok-via-floci"
  echo ""
  echo "  API GW integration already targets http://${ALIAS}/ — no patch needed."
  echo "  Run the gate: bash infra/environments/local/spike-floci/smoke-test.sh"
else
  no "alias attached but proxy check did not return the expected body (got: '${BODY:0:60}')"
  inf "the users/backend container may not be ready yet; re-run after it is up."
  exit 1
fi
