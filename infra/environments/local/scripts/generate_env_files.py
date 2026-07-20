#!/usr/bin/env python3
"""Generate every env file that derives from Terraform discovery.

Usage: generate_env_files.py [--repo-root PATH]

Produces five files, each for one consumer:

  .env                 the ONLY four vars docker-compose interpolates as ${VAR}
  .env.local.infra     terraform outputs — read by the E2E suite and by humans
  .env.local.users     the Users service environment   (compose env_file:)
  .env.local.orders    the Orders service environment  (compose env_file:)
  .env.local.debug     HOST-reachable connection strings for a SQL client

WHY PER-SERVICE FILES, and not the single `.services` file originally sketched:
DATABASE_WRITER_URL and DATABASE_READER_URL exist in BOTH services with
different values AND different formats — a postgres:// URL for Users, an ADO
connection string for Orders. One shared file cannot hold two values for one
key without renaming variables the application code already reads.

IMPORTANT — no interpolation here. docker-compose expands ${USERS_DB_PORT} in
the compose file, but `env_file:` does NOT: values are taken literally. So every
port and id is resolved to its real value as the file is written. A `${...}`
left in one of these files would reach the service as that literal string.

Every value is REQUIRED. A missing one raises rather than writing an empty
string, because an empty segment inside a connection string yields a service
that starts and then cannot connect — much harder to diagnose than failing here.
"""

import argparse
import sys
from pathlib import Path

from lib3mrai.console import inf, ok
from lib3mrai.db import discover_port
from lib3mrai.envfile import MissingValue, terraform_output, write_env_file

# Shared local-dev constants. These are NOT secrets: Floci accepts test/test,
# and the gRPC key and webhook secret are local-only values (prod reads both
# from Secrets Manager per ADR-0007).
AWS_ENDPOINT = "http://floci:4566"
AWS_REGION = "us-east-1"
OTLP_ENDPOINT = "http://otel-collector:4318"
GRPC_API_KEY = "local-dev-grpc-key"
FLOCI_HOST = "floci"


def build(repo_root: Path) -> dict[Path, dict]:
    """Resolve every value once, then describe each file to write."""
    tf_dir = repo_root / "infra" / "environments" / "local"

    pool_id = terraform_output(tf_dir, "cognito_user_pool_id")
    client_id = terraform_output(tf_dir, "cognito_client_id")
    api_id = terraform_output(tf_dir, "api_id")
    users_db_host = terraform_output(tf_dir, "db_writer_endpoint")
    orders_db_host = terraform_output(tf_dir, "orders_db_writer_endpoint")

    # Discovered per-engine, never assumed: Floci assigns proxy ports 7000-7099
    # by cluster creation order, so postgres and mysql swap across applies.
    pg_port = discover_port("postgres")
    my_port = discover_port("mysql")

    api_gateway_url = f"http://localhost:4566/restapis/{api_id}/$default/_user_request_"

    # In-container connection strings: reached by the compose service name, on
    # the discovered proxy port.
    users_db = f"postgres://test:test@{FLOCI_HOST}:{pg_port}/users"
    orders_db = (
        f"Server={FLOCI_HOST};Port={my_port};Database=orders;"
        "User=test;Password=test;SslMode=None;"
    )

    return {
        # --- root .env: ONLY what compose interpolates -----------------------
        # Anything else here would be dead weight; anything MISSING here breaks
        # compose silently, because ${VAR} with no value resolves to "".
        repo_root / ".env": dict(
            header="Consumed by docker-compose ${VAR} interpolation ONLY. Service "
            "environments live in .env.local.<service>.",
            generated={
                "COGNITO_USER_POOL_ID": pool_id,
                "COGNITO_CLIENT_ID": client_id,
                "USERS_DB_PORT": str(pg_port),
                "ORDERS_DB_PORT": str(my_port),
            },
        ),
        # --- infra: terraform outputs, for the E2E suite and for humans ------
        repo_root / ".env.local.infra": dict(
            header="Infrastructure outputs (terraform). Read by the E2E suite.",
            generated={
                "COGNITO_USER_POOL_ID": pool_id,
                "COGNITO_CLIENT_ID": client_id,
                "API_GATEWAY_URL": api_gateway_url,
                "USERS_DB_HOST": users_db_host,
                "ORDERS_DB_HOST": orders_db_host,
                "USERS_DB_PORT": str(pg_port),
                "ORDERS_DB_PORT": str(my_port),
            },
        ),
        # --- users service ---------------------------------------------------
        repo_root / ".env.local.users": dict(
            header="Users service environment. Loaded via env_file: in docker-compose.yml.",
            generated={
                "AWS_ENDPOINT_URL": AWS_ENDPOINT,
                "AWS_REGION": AWS_REGION,
                "AWS_ACCESS_KEY_ID": "test",
                "AWS_SECRET_ACCESS_KEY": "test",
                "DATABASE_WRITER_URL": users_db,
                "DATABASE_READER_URL": users_db,
                "COGNITO_USER_POOL_ID": pool_id,
                "COGNITO_CLIENT_ID": client_id,
                "GRPC_API_KEY": GRPC_API_KEY,
                "OTEL_EXPORTER_OTLP_ENDPOINT": OTLP_ENDPOINT,
                "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
                "OTEL_METRICS_EXPORTER": "none",
                "OTEL_LOGS_EXPORTER": "none",
            },
            custom_defaults={
                "PORT": "3000",
                "GRPC_PORT": "50051",
                "WEBHOOK_SECRET": "local-dev-secret",
            },
        ),
        # --- orders service --------------------------------------------------
        repo_root / ".env.local.orders": dict(
            header="Orders service environment. Loaded via env_file: in docker-compose.yml.",
            generated={
                "AWS_ENDPOINT_URL": AWS_ENDPOINT,
                "AWS_REGION": AWS_REGION,
                "AWS_ACCESS_KEY_ID": "test",
                "AWS_SECRET_ACCESS_KEY": "test",
                "DATABASE_WRITER_URL": orders_db,
                "DATABASE_READER_URL": orders_db,
                "USERS_GRPC_URL": "http://users:50051",
                "GRPC_API_KEY": GRPC_API_KEY,
                "OTEL_EXPORTER_OTLP_ENDPOINT": OTLP_ENDPOINT,
                "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
                "OTEL_DIAGNOSTICS__LOGLEVEL": "Error",
            },
            custom_defaults={"SEED_ON_STARTUP": "true"},
        ),
        # --- debug: HOST-reachable, loaded by nothing ------------------------
        # Floci's RDS proxy is published to the host, so these reach the DBs
        # from outside Docker (a SQL client on macOS). Deliberately not loaded
        # by any service: a host URL inside a container would not resolve.
        repo_root / ".env.local.debug": dict(
            header="HOST-reachable connection strings for a local SQL client. "
            "Loaded by nothing — copy the value you need.",
            generated={
                "USERS_DATABASE_URL": f"postgres://test:test@localhost:{pg_port}/users",
                "ORDERS_DATABASE_URL": f"mysql://test:test@localhost:{my_port}/orders",
                "USERS_DB_PROXY_HOST": users_db_host,
                "ORDERS_DB_PROXY_HOST": orders_db_host,
            },
        ),
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[4],
        help="repo root (defaults to four levels up from this script)",
    )
    args = parser.parse_args(argv[1:])

    try:
        files = build(args.repo_root)
    except (MissingValue, LookupError) as exc:
        print(f"generate_env_files.py: {exc}", file=sys.stderr)
        return 1

    for path, spec in files.items():
        try:
            write_env_file(path, **spec)
        except MissingValue as exc:
            print(f"generate_env_files.py: {exc}", file=sys.stderr)
            return 1
        inf(f"wrote {path.relative_to(args.repo_root)}")

    ok(f"generated {len(files)} env files (CUSTOM sections preserved)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
