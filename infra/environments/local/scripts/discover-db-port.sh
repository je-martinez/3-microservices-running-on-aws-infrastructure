#!/usr/bin/env bash
# Discover the RDS-proxy port Floci assigned to a cluster, BY ENGINE.
# Usage: discover-db-port.sh <engine:postgres|mysql>
#
# WHY THIS EXISTS ───────────────────────────────────────────────────────────
# Floci assigns RDS-proxy ports (range 7000-7099) BY CLUSTER CREATION ORDER,
# which is NOT stable across `terraform apply` runs. With two clusters (Users
# Postgres + Orders MySQL) the assignment can flip: one apply yields
# postgres=7001/mysql=7002, another yields mysql=7001/postgres=7002. Any code
# that hardcodes 7001=Postgres / 7002=MySQL breaks whenever Floci flips them.
#
# `describe-db-clusters` exposes `Engine` per cluster, so we discover the port
# for a given engine instead of guessing by order. This is the SINGLE reusable
# discovery mechanism, called from the Makefile recipes and bootstrap.sh (DRY).
#
# Echoes just the port to stdout (so callers can capture it), exits non-zero
# with a message on stderr if the engine's cluster/port is not found.
#
# AWS creds/endpoint for the CLI against Floci come from the environment
# (AWS_ENDPOINT_URL / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION);
# the Makefile already exports them, and we default the endpoint below so the
# script also works when sourced/called standalone.
set -euo pipefail

ENGINE="${1:-}"
if [ -z "$ENGINE" ]; then
  echo "discover-db-port.sh: missing engine argument (postgres|mysql)" >&2
  exit 2
fi

# Default the endpoint so the script is self-contained; an already-exported
# AWS_ENDPOINT_URL (e.g. from the Makefile) wins.
export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"

PORT="$(aws --endpoint-url "$AWS_ENDPOINT_URL" rds describe-db-clusters \
  --query "DBClusters[?Engine=='${ENGINE}'].Port" --output text 2>/dev/null || true)"

# `--output text` yields an empty string (or the literal "None") when no cluster
# matches the engine; treat both as "not found".
if [ -z "$PORT" ] || [ "$PORT" = "None" ]; then
  echo "discover-db-port.sh: no ${ENGINE} cluster/port found via describe-db-clusters (is Floci up and applied?)" >&2
  exit 1
fi

echo "$PORT"
