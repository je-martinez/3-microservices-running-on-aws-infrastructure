#!/usr/bin/env python3
"""Advance a tracking's delivery status as the carrier would, for local testing.

Drives the real carrier webhook (PUT /v1/trackings/{order_id}/status) through the
API Gateway with the carrier API key, so the notification/toast cascade fires the
same way it does in production.

CONTRACT: This is a LOCAL developer tool. It reads the carrier API key and, for
--order-number, queries the tracking database directly — neither is acceptable
against a deployed environment. See [[two-api-keys-two-trust-domains]]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from lib3mrai.console import inf, no, ok
from lib3mrai.db import COMPOSE_NETWORK, discover_port

REPO_ROOT = Path(__file__).resolve().parents[2]

# The carrier surface has exactly ONE route and it is a PUT, so there is no way
# to READ a status with the API key. --next and --all therefore take the current
# status from the database, and from the PUT's own response body thereafter.
CARRIER_PATH = "/v1/trackings/{order_id}/status"

# CONTRACT: The order here IS the progression; the service derives nothing from
# this copy. It mirrors services/tracking-go/internal/domain/status.go, which
# stays authoritative — the server rejects anything this disagrees with.
STATUS_ORDER = (
    "PLACED",
    "PROCESSING",
    "SHIPPED",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
)
INITIAL_STATUS = "PLACED"
TERMINAL_STATUS = "DELIVERED"

# CONTRACT: Read these files, never `source` them. API_GATEWAY_URL contains a
# literal `$default` path segment, which a shell expands to the empty string —
# producing a URL that 404s from Floci's S3 handler. See [[env-files]]
DEFAULT_ENV_FILES = (".env.local.tracking", ".env.local.infra")

ORDER_ID_PREFIX = "ord_"
ORDER_NUMBER_LENGTH = 12

# WHY: 8s clears the 7s toast lifetime (TOAST_DISMISS_MS in the web app's
# toast-queue.ts), so each toast is seen whole and closes before the next
# arrives — the reason to watch an --all run at all.
DEFAULT_DELAY_SECONDS = 8.0

# WARNING: Below five seconds the emulator DROPS TRACKING_STATUS_CHANGED events,
# so the cascade arrives incomplete — the same floor TestMode's
# PROGRESSION_INTERVAL_SECONDS is pinned to. Warned about, not enforced: a
# developer who is not watching may want --delay 0. See [[tracking-service-design]]
MIN_SAFE_DELAY_SECONDS = 5.0

MYSQL_IMAGE = "mysql:8"
TRACKING_DATABASE = "tracking"
MYSQL_HOST = "floci"
MYSQL_USER = "test"
MYSQL_PASSWORD = "test"


class ResolutionError(Exception):
    """An order could not be resolved to exactly one live tracking."""


class ConfigError(Exception):
    """A required value was absent from the env files."""


def read_env_files(paths: list[Path]) -> dict[str, str]:
    """Parse KEY=VALUE pairs out of env files, earlier files winning.

    A hand-rolled parser rather than a shell: see the DEFAULT_ENV_FILES contract.
    """
    values: dict[str, str] = {}
    for path in paths:
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values.setdefault(key.strip(), value.strip().strip("'\""))
    return values


def require(values: dict[str, str], key: str, paths: list[Path]) -> str:
    """Return `key` or raise naming it and where it was looked for."""
    value = values.get(key)
    if not value:
        names = ", ".join(str(p) for p in paths)
        raise ConfigError(f"{key} is not set in any of: {names}. Has `make env-file` run?")
    return value


def normalize_order_number(value: str) -> str:
    """Return the CANONICAL spelling of an order number.

    CONTRACT: Match untrusted input against the canonical form AFTER stripping the
    separator, never against the displayed one — Orders mints `260918F2MM7M` and
    stores that, while every surface shows `260918-F2MM7M`, so a number copied off
    the screen finds nothing. See [[friendly-order-number]]
    """
    return value.replace("-", "")


def classify(value: str) -> str:
    """Return "order_id" or "order_number" for a bare positional value."""
    if value.startswith(ORDER_ID_PREFIX):
        return "order_id"
    if len(normalize_order_number(value)) == ORDER_NUMBER_LENGTH:
        return "order_number"
    raise ResolutionError(
        f"cannot tell what '{value}' is: an order id starts with '{ORDER_ID_PREFIX}' "
        f"and an order number is {ORDER_NUMBER_LENGTH} characters, with or without "
        "its separator. Pass --order-id or --order-number to be explicit."
    )


def mysql_query(sql: str, port: int) -> list[list[str]]:
    """Run `sql` against the tracking database, returning tab-split rows.

    WORKAROUND(local): Shell out to a mysql:8 container on the compose network
    rather than using a driver — no MySQL driver is installed in the repo venv,
    and this matches how grant_mysql_provider_privileges.py reaches the same DB.

    --ssl-mode=DISABLED is required: Floci's RDS proxy does not terminate TLS, so
    the client's default handshake fails with "ERROR 2026 (HY000): SSL connection
    error". See [[floci-rds-apigw-limits]]
    """
    result = subprocess.run(
        [
            "docker", "run", "--rm", "--network", COMPOSE_NETWORK, MYSQL_IMAGE,
            "mysql", "--ssl-mode=DISABLED",
            "-h", MYSQL_HOST, "-P", str(port),
            "-u", MYSQL_USER, f"-p{MYSQL_PASSWORD}",
            TRACKING_DATABASE, "-N", "-B", "-e", sql,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        # The password warning mysql writes to stderr on every run is noise; the
        # real error is whatever else is there.
        detail = "\n".join(
            line for line in result.stderr.splitlines()
            if "Using a password on the command line" not in line
        )
        raise ResolutionError(f"tracking database query failed: {detail.strip()}")
    return [line.split("\t") for line in result.stdout.splitlines() if line]


def lookup(field: str, value: str, port: int) -> tuple[str, str, str]:
    """Resolve a live tracking to (order_id, order_number, status).

    CONTRACT: Filter deleted_at IS NULL, and report a duplicate order_number
    rather than taking the first row — it carries no unique index. A row the e2e
    cleanup soft-deleted otherwise resolves here and then 404s at the gateway.
    See [[tracking-service-design]]
    """
    # The value is a bound-free identifier, so it is escaped rather than
    # parameterized: the mysql CLI takes one -e string and offers no bind slots.
    escaped = value.replace("\\", "\\\\").replace("'", "\\'")
    rows = mysql_query(
        "SELECT order_id, IFNULL(order_number, ''), status FROM tracking "
        f"WHERE {field} = '{escaped}' AND deleted_at IS NULL",
        port,
    )
    if not rows:
        raise ResolutionError(
            f"no live tracking with {field} '{value}'. "
            "It may not exist, or it may have been soft-deleted by an e2e cleanup run."
        )
    if len(rows) > 1:
        found = ", ".join(row[0] for row in rows)
        raise ResolutionError(
            f"{len(rows)} live trackings share {field} '{value}' ({found}). "
            "Pass --order-id to pick one."
        )
    return rows[0][0], rows[0][1] or "(null)", rows[0][2]


def put_status(base_url: str, api_key: str, order_id: str, status: str) -> tuple[int, dict]:
    """PUT the new status, returning (http_status, parsed_body).

    The success body is the full tracking, so the resulting status is read from
    the response instead of costing another query.
    """
    url = base_url.rstrip("/") + CARRIER_PATH.format(order_id=order_id)
    request = urllib.request.Request(
        url,
        method="PUT",
        data=json.dumps({"status": status}).encode(),
        headers={"content-type": "application/json", "x-api-key": api_key},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        # WHY: Read the error body. Every 4xx here carries the server's own
        # `detail`/`reason`, which is the whole diagnosis — the bare code is not.
        raw = error.read()
        try:
            return error.code, json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return error.code, {"detail": raw.decode(errors="replace").strip()}
    except urllib.error.URLError as error:
        raise ConfigError(f"cannot reach the gateway at {url}: {error.reason}") from error


def describe_failure(body: dict) -> str:
    """The server's explanation, however it shaped the body."""
    detail = body.get("detail")
    if isinstance(detail, list):
        # The 422 shape: a list of per-field validation entries.
        return "; ".join(
            f"{'.'.join(str(p) for p in entry.get('loc', []))}: {entry.get('msg', '')}"
            for entry in detail
        )
    if detail:
        reason = body.get("reason")
        return f"{detail}" + (f" [reason: {reason}]" if reason else "")
    return json.dumps(body) if body else "(empty response body)"


def planned_steps(current: str, args: argparse.Namespace) -> list[str]:
    """The statuses to request, in order, for the chosen mode."""
    if args.status:
        return [args.status]

    index = STATUS_ORDER.index(current) if current in STATUS_ORDER else -1
    if index < 0:
        raise ResolutionError(
            f"current status '{current}' is not one of {', '.join(STATUS_ORDER)}"
        )
    remaining = list(STATUS_ORDER[index + 1:])
    if not remaining:
        raise ResolutionError(
            f"tracking is already {TERMINAL_STATUS}; there is nothing left to advance"
        )
    return remaining[:1] if args.next else remaining


def progress(message: str) -> None:
    """An `inf` line that cannot be overtaken by a later failure.

    CONTRACT: Flush before returning. stderr is unbuffered and a piped stdout is
    not, so a failure line otherwise prints ABOVE the context line explaining
    it — under `| tee`, but not on a terminal.
    """
    inf(message)
    sys.stdout.flush()


def run(args: argparse.Namespace) -> int:
    env_paths = [
        (path if path.is_absolute() else REPO_ROOT / path)
        for path in (args.env or [Path(name) for name in DEFAULT_ENV_FILES])
    ]
    env = read_env_files(env_paths)

    if args.order_id:
        field, value = "order_id", args.order_id
    elif args.order_number:
        field, value = "order_number", normalize_order_number(args.order_number)
    else:
        field = classify(args.order)
        value = normalize_order_number(args.order) if field == "order_number" else args.order

    port = discover_port("mysql")
    order_id, order_number, current = lookup(field, value, port)
    progress(f"tracking {order_id} (order_number {order_number}) is {current}")

    steps = planned_steps(current, args)

    if args.dry_run:
        chain = " → ".join([current, *steps])
        progress(f"dry run — would request: {chain}")
        for step in steps:
            progress(f"  PUT {CARRIER_PATH.format(order_id=order_id)} {{\"status\": \"{step}\"}}")
        return 0

    base_url = require(env, "API_GATEWAY_URL", env_paths)
    api_key = require(env, "TRACKING_CARRIER_API_KEY", env_paths)

    if len(steps) > 1 and args.delay < MIN_SAFE_DELAY_SECONDS:
        progress(
            f"warning: --delay {args.delay:g} is below the {MIN_SAFE_DELAY_SECONDS:g}s floor; "
            "the emulator may drop TRACKING_STATUS_CHANGED events and the cascade "
            "may arrive incomplete"
        )

    for position, requested in enumerate(steps):
        if position:
            # WHY: Pause BETWEEN steps only. The cascade is watched live in the
            # UI, and a burst of five updates arrives as one indistinguishable
            # clump of toasts.
            time.sleep(args.delay)

        code, body = put_status(base_url, api_key, order_id, requested)
        if code != 200:
            no(f"{current} → {requested} rejected (HTTP {code}): {describe_failure(body)}")
            return 1

        current = body.get("status", requested)
        ok(f"{STATUS_ORDER[STATUS_ORDER.index(current) - 1]} → {current} (HTTP {code})")

    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Advance a tracking's delivery status as the carrier would, "
            "driving the real gateway webhook."
        ),
        epilog=(
            "examples:\n"
            "  %(prog)s ord_aGFyfye2tbdburZC80nMxJ7n --next\n"
            "  %(prog)s 260915C6119V --all\n"
            "  %(prog)s --order-id ord_… --status SHIPPED\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "order",
        nargs="?",
        help="order id (ord_…) or order number, with or without its separator",
    )
    parser.add_argument("--order-id", help="order id, stated explicitly")
    parser.add_argument("--order-number", help="order number, stated explicitly")

    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--status", choices=STATUS_ORDER, help="request this status")
    mode.add_argument("--next", action="store_true", help="advance exactly one step")
    mode.add_argument(
        "--all", action="store_true", help=f"advance every step through {TERMINAL_STATUS}"
    )

    parser.add_argument(
        "--env",
        type=Path,
        action="append",
        metavar="FILE",
        help=f"env file to read config from (default: {', '.join(DEFAULT_ENV_FILES)})",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=DEFAULT_DELAY_SECONDS,
        metavar="SECONDS",
        help=(
            "pause between --all steps so the toasts are watchable "
            f"(default: {DEFAULT_DELAY_SECONDS:g})"
        ),
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="print the requests without sending them"
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if sum(bool(v) for v in (args.order, args.order_id, args.order_number)) != 1:
        parser.error("give exactly one of: a positional order, --order-id, or --order-number")
    if args.status == INITIAL_STATUS:
        parser.error(
            f"{INITIAL_STATUS} is the creation state, never a transition target; "
            f"the server rejects it with 400"
        )

    try:
        return run(args)
    except (ResolutionError, ConfigError) as error:
        no(str(error))
        return 1


if __name__ == "__main__":
    sys.exit(main())
