#!/usr/bin/env bash
# Polls a DB endpoint until it accepts connections, or fails after a timeout.
# Usage: wait-for-db.sh <host> <port> <engine:postgres|mysql>
#
# Runs the probe INSIDE a throwaway container joined to Floci's compose network
# (3mrai_3mrai-network) so it resolves the `floci` service by name — same
# network the app containers use. Exits 0 as soon as the DB is ready, 1 on
# timeout, 2 on an unknown engine.
set -euo pipefail
HOST="$1"; PORT="$2"; ENGINE="$3"
ATTEMPTS="${WAIT_ATTEMPTS:-30}"; SLEEP="${WAIT_SLEEP:-2}"

for i in $(seq 1 "$ATTEMPTS"); do
  case "$ENGINE" in
    postgres)
      if docker run --rm --network 3mrai_3mrai-network postgres:14.6-alpine \
        pg_isready -h "$HOST" -p "$PORT" >/dev/null 2>&1; then
        echo "postgres at $HOST:$PORT ready"; exit 0
      fi ;;
    mysql)
      if docker run --rm --network 3mrai_3mrai-network mysql:8 \
        mysqladmin ping --ssl-mode=DISABLED -h "$HOST" -P "$PORT" --silent >/dev/null 2>&1; then
        echo "mysql at $HOST:$PORT ready"; exit 0
      fi ;;
    *) echo "unknown engine: $ENGINE" >&2; exit 2 ;;
  esac
  echo "waiting for $ENGINE at $HOST:$PORT ($i/$ATTEMPTS)…"; sleep "$SLEEP"
done
echo "timed out waiting for $ENGINE at $HOST:$PORT" >&2
exit 1
