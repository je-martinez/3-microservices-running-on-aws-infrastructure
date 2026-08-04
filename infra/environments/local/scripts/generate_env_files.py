#!/usr/bin/env python3
"""Generate every env file that derives from Terraform discovery.

Usage: generate_env_files.py [--repo-root PATH]

Produces six files, each for one consumer:

  .env                 the ONLY four vars docker-compose interpolates as ${VAR}
  .env.local.infra     terraform outputs — read by the E2E suite and by humans
  .env.local.users     the Users service environment    (compose env_file:)
  .env.local.orders    the Orders service environment   (compose env_file:)
  .env.local.tracking  the Tracking service environment (compose env_file:)
  .env.local.debug     HOST-reachable connection strings for a SQL client

WHY PER-SERVICE FILES, and not the single `.services` file originally sketched:
DATABASE_WRITER_URL and DATABASE_READER_URL exist in EVERY service with
different values AND different formats — a postgres:// URL for Users, an ADO
connection string for Orders, a SQLAlchemy URL for Tracking. One shared file
cannot hold three values for one key without renaming variables the application
code already reads.

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
FLOCI_HOST = "floci"

# ─── The two key-based auth schemes — KEEP THEM SEPARATE ─────────────────────
# These are two different keys for two different TRUST DOMAINS. Do not
# "simplify" by collapsing them into one constant, and do not point both env
# vars at the same value. See the Tracking design's "Auth schemes" section
# (docs/domains/tracking/specs/tracking-service-design.md).
#
#   GRPC_API_KEY            INTERNAL. Shared symmetric secret between our own
#                           services. Users is the only gRPC server left, and
#                           both Orders and Tracking call it to resolve a
#                           caller's identity, carrying this as `x-api-key`
#                           metadata; the interceptor compares it in constant
#                           time (see docs/domains/orders/decisions/
#                           grpc-api-key-authorization.md). Orders reaches
#                           Tracking over HTTP instead — Tracking serves no
#                           gRPC. This key never leaves the compose network/VPC.
#
#   TRACKING_CARRIER_API_KEY  EXTERNAL. Issued to a third-party shipping carrier
#                           so it can call PUT /v1/trackings/{orderId}/status.
#                           That gateway route is declared `auth = false` — it
#                           sits OUTSIDE the Cognito authorizer, so the Tracking
#                           service validates this key itself.
#
# Reusing the internal key as the carrier key would hand an outside vendor a
# credential that authenticates as an internal service against every gRPC
# surface we have. The blast radius is the entire inter-service mesh, so the
# separation is a security boundary, not a naming preference.
#
# Both are local-dev placeholders here, matching how GRPC_API_KEY has always
# been sourced locally (a static constant, no Terraform resource). Neither is
# provisioned in Parameter Store or Secrets Manager: as of today this repo has
# ZERO `aws_ssm_parameter` resources, and Secrets Manager holds only
# Terraform-generated DB credentials. Real rotation for both keys is prod work,
# deferred exactly like every other secret in ADR-0007.
GRPC_API_KEY = "local-dev-grpc-key"
TRACKING_CARRIER_API_KEY = "local-dev-carrier-key"


def build(repo_root: Path) -> dict[Path, dict]:
    """Resolve every value once, then describe each file to write."""
    tf_dir = repo_root / "infra" / "environments" / "local"

    pool_id = terraform_output(tf_dir, "cognito_user_pool_id")
    client_id = terraform_output(tf_dir, "cognito_client_id")
    api_id = terraform_output(tf_dir, "api_id")
    users_db_host = terraform_output(tf_dir, "db_writer_endpoint")
    orders_db_host = terraform_output(tf_dir, "orders_db_writer_endpoint")
    # Tracking shares the Orders MySQL CLUSTER — only the database differs (see
    # terraform_data.tracking_database in main.tf). Read from Tracking's OWN
    # output rather than reusing orders_db_host: the value is identical today,
    # but addressing it by its own key keeps the two services decoupled if
    # Tracking ever moves to its own cluster.
    tracking_db_host = terraform_output(tf_dir, "tracking_db_writer_endpoint")

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
    # Tracking is Python/SQLAlchemy, so its URL is a SQLAlchemy DSN — NOT the
    # .NET `Server=...;Database=...;` form Orders uses, even though both point
    # at the same MySQL cluster on the same discovered port.
    #
    # Driver `pymysql`: the pure-Python DBAPI, the only MySQL driver this repo
    # has ever named (the scaffold design calls out psycopg2/pymysql as the
    # bundled drivers). Sync rather than async (aiomysql/asyncmy) because
    # nothing in the Tracking design commits to an async engine, Alembic
    # migrations run against a sync engine regardless, and pymysql needs no
    # build toolchain in the container (unlike mysqlclient's C extension). If
    # the service later adopts `create_async_engine`, this becomes
    # `mysql+aiomysql://` — a one-line change here, since the URL is generated.
    #
    # ?charset=utf8mb4 matches the collation the tracking database is created
    # with; pymysql otherwise negotiates latin1 and mangles non-ASCII text.
    # No TLS parameters: Floci's MySQL proxy does not terminate TLS.
    tracking_db = (
        f"mysql+pymysql://test:test@{FLOCI_HOST}:{my_port}/tracking?charset=utf8mb4"
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
                "TRACKING_DB_HOST": tracking_db_host,
                "USERS_DB_PORT": str(pg_port),
                "ORDERS_DB_PORT": str(my_port),
                # Same cluster as Orders, so the same discovered port. Named
                # separately so a consumer never has to know they coincide.
                "TRACKING_DB_PORT": str(my_port),
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
                # Gates the E2E-only routes (cleanup, identity) and the
                # "E2E Source" tag the suite asserts on. Local-only: never true
                # in a deployed environment.
                "E2E_TESTING_ENABLED": "true",
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
                # Tracking is reached over HTTP, not gRPC: it serves no gRPC
                # surface. Orders POSTs the caller's order here to open a
                # tracking record, forwarding the x-user-id it received.
                "TRACKING_BASE_URL": "http://tracking:8000",
                "GRPC_API_KEY": GRPC_API_KEY,
                "OTEL_EXPORTER_OTLP_ENDPOINT": OTLP_ENDPOINT,
                "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
                "OTEL_DIAGNOSTICS__LOGLEVEL": "Error",
            },
            custom_defaults={
                "SEED_ON_STARTUP": "true",
                # Gates the flag-guarded E2E cleanup endpoint. Local-only.
                "E2E_TESTING_ENABLED": "true",
            },
        ),
        # --- tracking service ------------------------------------------------
        # Python/FastAPI/SQLAlchemy. Same MySQL cluster as Orders, different
        # database — hence the same discovered port with `/tracking` as the
        # database segment.
        repo_root / ".env.local.tracking": dict(
            header="Tracking service environment. Loaded via env_file: in docker-compose.yml.",
            generated={
                "AWS_ENDPOINT_URL": AWS_ENDPOINT,
                "AWS_REGION": AWS_REGION,
                "AWS_ACCESS_KEY_ID": "test",
                "AWS_SECRET_ACCESS_KEY": "test",
                # Writer and reader are the same value locally: Floci does not
                # emulate an Aurora read replica. Both keys exist anyway so the
                # service can honor ADR-0006 (reads on the reader) unchanged
                # between local and prod.
                "DATABASE_WRITER_URL": tracking_db,
                "DATABASE_READER_URL": tracking_db,
                # Tracking serves no gRPC. Its one gRPC call goes OUT, to Users,
                # to resolve the caller's usr_ id from the Cognito sub the
                # gateway hands it — the same lookup Orders makes.
                "USERS_GRPC_URL": "http://users:50051",
                # The INTERNAL service-to-service key — the same value Users and
                # Orders share. Tracking presents it when calling Users, rather
                # than validating it on the way in.
                "GRPC_API_KEY": GRPC_API_KEY,
                # The EXTERNAL carrier/webhook key, validated by the service
                # itself on PUT /v1/trackings/{orderId}/status (a gateway route
                # with NO Cognito authorizer). A DIFFERENT value from
                # GRPC_API_KEY on purpose — see the trust-domain note at the top
                # of this file before touching either.
                "TRACKING_CARRIER_API_KEY": TRACKING_CARRIER_API_KEY,
                "OTEL_EXPORTER_OTLP_ENDPOINT": OTLP_ENDPOINT,
                "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
                "OTEL_METRICS_EXPORTER": "none",
                "OTEL_LOGS_EXPORTER": "none",
            },
            custom_defaults={
                # uvicorn's default port; 3000/8080 are taken by Users/Orders.
                # Tracking serves HTTP only — it has no gRPC port because it has
                # no gRPC server.
                "PORT": "8000",
                # Gates the flag-guarded E2E cleanup endpoint, the same way it
                # does for Users and Orders. Without it the route is not mounted
                # at all, and the harness's teardown gets a 405 rather than a
                # cleanup. Local-only: never true in a deployed environment.
                "E2E_TESTING_ENABLED": "true",
            },
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
                # Plain mysql:// (not mysql+pymysql://) — this file is for a GUI
                # SQL client, which wants a generic URL, not a SQLAlchemy DSN.
                "TRACKING_DATABASE_URL": f"mysql://test:test@localhost:{my_port}/tracking",
                "USERS_DB_PROXY_HOST": users_db_host,
                "ORDERS_DB_PROXY_HOST": orders_db_host,
                "TRACKING_DB_PROXY_HOST": tracking_db_host,
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
