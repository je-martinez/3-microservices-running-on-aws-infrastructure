#!/usr/bin/env bash
# bootstrap.sh — local Floci post-apply steps:
#   1. create the least-privilege app DB user (replaces what
#      module.rds_aurora's manage_app_user used to do — disabled locally,
#      see environments/local/main.tf).
#   2. attach a STABLE Docker-DNS alias to the nginx ECS container.
#
# The two steps are INDEPENDENT: step 1 runs first and does not depend on the
# nginx/users containers being up; step 2 (unchanged from before) depends on
# the `users` compose service being up and will fail on its own if it isn't
# (expected until compose is rewired — a separate task). Run the whole script,
# or source it and call bootstrap_app_db_user directly to run step 1 alone.
#
# ── Step 1 — why this exists ──────────────────────────────────────────────
#   module.rds_aurora's postgresql_* resources (least-privilege app DB user)
#   are disabled locally (manage_app_user = false): the `postgresql` Terraform
#   provider would need to be configured with the cluster's endpoint BEFORE
#   the cluster exists — a chicken-and-egg no default can resolve on a clean
#   apply (see environments/local/providers.tf). This step recreates that
#   same user directly against the running cluster, once it exists.
#
# ── Step 2 — why this exists ──────────────────────────────────────────────
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
# Both steps are idempotent: safe to run repeatedly. Run the whole script once
# after each `terraform apply`.
#
# Usage:
#   bash infra/environments/local/bootstrap.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NETWORK="3mrai_3mrai-network"
ALIAS="${NGINX_STABLE_ALIAS:-nginx-stable}"
FIXED_IP="${NGINX_STABLE_IP:-192.168.155.20}"   # empty → alias only, keep auto IP

# App DB user (step 1). PG_HOST defaults to the stable compose service
# hostname (survives container recreation, per JE-36/verified route) rather
# than a discovered container IP, which changes across recreations.
PG_HOST="${PG_HOST:-floci}"
PG_PORT="${PG_PORT:-7001}"
PG_SUPERUSER="${PG_SUPERUSER:-test}"
PG_SUPERUSER_PASSWORD="${PG_SUPERUSER_PASSWORD:-test}"
PG_DATABASE="${PG_DATABASE:-users}"
APP_DB_USER="${APP_DB_USER:-users_app}" # must match module.rds_aurora's app_username default
APP_DB_SECRET_FILE="${APP_DB_SECRET_FILE:-${SCRIPT_DIR}/.app-db-secret}" # git-ignored, local only

G='\033[0;32m'; R='\033[0;31m'; N='\033[0m'
ok(){ echo -e "  ${G}OK${N}: $1"; }
no(){ echo -e "  ${R}NO${N}: $1"; }
inf(){ echo -e "  $1"; }

# ─── Step 1: least-privilege app DB user ────────────────────────────────────
bootstrap_app_db_user() {
  echo "== bootstrap: least-privilege app DB user (${APP_DB_USER}) =="

  # Idempotent password: reuse a previously generated one (git-ignored local
  # file) instead of rotating it on every run, which would desync any
  # already-running service connection.
  if [ -f "$APP_DB_SECRET_FILE" ]; then
    APP_DB_PASSWORD="$(cat "$APP_DB_SECRET_FILE")"
    inf "reusing existing local password from ${APP_DB_SECRET_FILE}"
  else
    APP_DB_PASSWORD="$(docker run --rm postgres:14.6-alpine sh -c 'head -c 18 /dev/urandom | base64' | tr -d '=+/\n' | cut -c1-24)"
    printf '%s' "$APP_DB_PASSWORD" >"$APP_DB_SECRET_FILE"
    chmod 600 "$APP_DB_SECRET_FILE"
    inf "generated a new local-only password (${APP_DB_SECRET_FILE}, not git-tracked)"
  fi

  # DO $$ ... $$ block: idempotent role creation (IF NOT EXISTS has no direct
  # CREATE ROLE equivalent), then plain (idempotent-by-nature) GRANTs.
  # SELECT/INSERT/UPDATE only — NO DELETE (ADR-0004: soft-delete is enforced
  # at the grant level, not just in application code).
  SQL=$(
    cat <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_DB_USER}') THEN
    CREATE ROLE ${APP_DB_USER} LOGIN PASSWORD '${APP_DB_PASSWORD}';
  ELSE
    ALTER ROLE ${APP_DB_USER} LOGIN PASSWORD '${APP_DB_PASSWORD}';
  END IF;
END
\$\$;

GRANT CONNECT ON DATABASE ${PG_DATABASE} TO ${APP_DB_USER};
GRANT USAGE ON SCHEMA public TO ${APP_DB_USER};
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${APP_DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO ${APP_DB_USER};
SQL
  )

  if docker run --rm --network "$NETWORK" -e PGPASSWORD="$PG_SUPERUSER_PASSWORD" postgres:14.6-alpine \
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_SUPERUSER" -d "$PG_DATABASE" -v ON_ERROR_STOP=1 -c "$SQL" >/tmp/bootstrap_pg.log 2>&1; then
    ok "role '${APP_DB_USER}' ready: CONNECT + USAGE(public) + SELECT/INSERT/UPDATE (no DELETE) on public tables, default privileges set for future tables"
  else
    no "failed to create/grant app DB user (see /tmp/bootstrap_pg.log)"
    cat /tmp/bootstrap_pg.log
    return 1
  fi
}

# Run step 1 independently of step 2: a step-1 failure is reported but does
# not abort step 2 (and vice versa — each is independently useful/runnable).
STEP1_STATUS=0
bootstrap_app_db_user || STEP1_STATUS=$?
echo ""

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
