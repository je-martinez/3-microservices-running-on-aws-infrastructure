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
#   The API GW's per-route integrations in main.tf point at
#   http://nginx-stable/<route-path> (the path is baked in because Floci drops
#   the request path), and `nginx-stable` never changes. So the integration URIs
#   are correct at apply time, Terraform state never drifts, and re-running just
#   re-points the same alias.
#
#   Floci's Route53 is management-plane only (no resolution) and ECS tasks aren't
#   registered in Cloud Map, so a Docker-native alias is the working approach
#   (Docker embedded DNS at 127.0.0.11 resolves it, including from Floci's API GW
#   container).
#
# The API GW integration proxies to the REAL `users` service, whose health
# endpoint returns {"status":"ok"} at /v1/health. The verification step below
# checks that.
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
# Empty by default → attach the alias only and let Docker assign the IP.
# The API GW per-route integrations target http://nginx-stable/<path> , so a
# stable NAME is all that is required; pinning an IP only adds a failure mode. Floci recreates its
# network with a different subnet across runs (observed 192.168.155.0/24 →
# 192.168.148.0/24), so any hardcoded address eventually falls outside it and
# `docker network connect --ip` fails with "no configured subnet contains ...".
# Set NGINX_STABLE_IP=<addr> to opt back in.
FIXED_IP="${NGINX_STABLE_IP:-}"

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

# ─── Step 1b: least-privilege Orders app DB user (MySQL) ────────────────────
# MySQL analog of bootstrap_app_db_user. Same rationale: module.rds_mysql's
# app-user resources are disabled locally (manage_app_user = false, chicken-and
# -egg), so create orders_app directly against the running MySQL cluster.
# SELECT/INSERT/UPDATE only — NO DELETE (ADR-0004). Unlike Postgres, MySQL's
# `GRANT ... ON orders.*` already covers future tables, so there is no
# ALTER DEFAULT PRIVILEGES equivalent to run.
ORDERS_DB_HOST="${ORDERS_DB_HOST:-floci}"
ORDERS_DB_PORT="${ORDERS_DB_PORT:-7002}"
ORDERS_DB_SUPERUSER="${ORDERS_DB_SUPERUSER:-test}"
ORDERS_DB_SUPERUSER_PASSWORD="${ORDERS_DB_SUPERUSER_PASSWORD:-test}"
ORDERS_DB_DATABASE="${ORDERS_DB_DATABASE:-orders}"
ORDERS_APP_DB_USER="${ORDERS_APP_DB_USER:-orders_app}"
ORDERS_APP_DB_SECRET_FILE="${ORDERS_APP_DB_SECRET_FILE:-${SCRIPT_DIR}/.orders-app-db-secret}"

# KNOWN LIMIT (verified 2026-07-15): Floci's emulated MySQL does NOT support user
# management — the only exposed user `test` lacks the global CREATE USER privilege
# (ERROR 1227), the mysql Terraform provider hangs on mysql_user, and Floci has no
# TLS while caching_sha2_password demands it. So orders_app CANNOT be created on
# Floci local (Postgres/users_app works; MySQL does not). Locally Orders connects
# as test/test; the least-privilege orders_app (no DELETE, ADR-0004) is a PROD-only
# concern handled by the RDS module / the post-effects apply. This function is kept
# for real AWS and is skipped on Floci unless FORCE_ORDERS_APP=1.
bootstrap_orders_app_db_user() {
  if [ "${FORCE_ORDERS_APP:-0}" != "1" ]; then
    inf "skipping orders_app: Floci MySQL has no user management (set FORCE_ORDERS_APP=1 to attempt against real AWS)"
    return 0
  fi
  echo "== bootstrap: least-privilege Orders app DB user (${ORDERS_APP_DB_USER}) =="

  if [ -f "$ORDERS_APP_DB_SECRET_FILE" ]; then
    ORDERS_APP_DB_PASSWORD="$(cat "$ORDERS_APP_DB_SECRET_FILE")"
    inf "reusing existing local password from ${ORDERS_APP_DB_SECRET_FILE}"
  else
    ORDERS_APP_DB_PASSWORD="$(docker run --rm mysql:8 sh -c 'head -c 18 /dev/urandom | base64' | tr -d '=+/\n' | cut -c1-24)"
    printf '%s' "$ORDERS_APP_DB_PASSWORD" >"$ORDERS_APP_DB_SECRET_FILE"
    chmod 600 "$ORDERS_APP_DB_SECRET_FILE"
    inf "generated a new local-only password (${ORDERS_APP_DB_SECRET_FILE}, not git-tracked)"
  fi

  # CREATE USER IF NOT EXISTS is natively idempotent in MySQL 8. ALTER USER keeps
  # the password in sync on re-runs. Grants are idempotent by nature.
  SQL=$(
    cat <<SQL
CREATE USER IF NOT EXISTS '${ORDERS_APP_DB_USER}'@'%' IDENTIFIED BY '${ORDERS_APP_DB_PASSWORD}';
ALTER USER '${ORDERS_APP_DB_USER}'@'%' IDENTIFIED BY '${ORDERS_APP_DB_PASSWORD}';
GRANT SELECT, INSERT, UPDATE ON ${ORDERS_DB_DATABASE}.* TO '${ORDERS_APP_DB_USER}'@'%';
FLUSH PRIVILEGES;
SQL
  )

  # --ssl-mode=DISABLED: Floci's emulated MySQL proxy does not terminate TLS, so
  # the client's default SSL handshake fails with "unexpected eof while reading".
  if docker run --rm --network "$NETWORK" mysql:8 \
    mysql --ssl-mode=DISABLED -h "$ORDERS_DB_HOST" -P "$ORDERS_DB_PORT" -u "$ORDERS_DB_SUPERUSER" -p"$ORDERS_DB_SUPERUSER_PASSWORD" \
    "$ORDERS_DB_DATABASE" -e "$SQL" >/tmp/bootstrap_mysql.log 2>&1; then
    ok "user '${ORDERS_APP_DB_USER}' ready: SELECT/INSERT/UPDATE (no DELETE) on ${ORDERS_DB_DATABASE}.*"
  else
    no "failed to create/grant Orders app DB user (see /tmp/bootstrap_mysql.log)"
    cat /tmp/bootstrap_mysql.log
    return 1
  fi
}

# Run step 1 independently of step 2: a step-1 failure is reported but does
# not abort step 2 (and vice versa — each is independently useful/runnable).
STEP1_STATUS=0
bootstrap_app_db_user || STEP1_STATUS=$?
bootstrap_orders_app_db_user || STEP1_STATUS=$?
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
  echo "  API GW per-route integrations already target http://${ALIAS}/<path> — no patch needed."
else
  no "alias attached but /v1/health did not return the expected body (got: '${BODY:0:80}')"
  inf "the users container may not be ready yet; re-run after it is up."
  exit 1
fi
