#!/usr/bin/env python3
"""Write the Stripe CLI's local webhook signing secret into Users' and Orders' env files.

CONTRACT: Use `stripe listen`'s OWN whsec_, never a Dashboard endpoint secret —
`stripe listen` signs forwarded events with its own secret, and a Dashboard
one fails verification with an HTTP 400. See [[stripe-sandbox-setup]]
WHY: One value for both services — the CLI's secret is identical across every
`stripe listen` process on a machine, and each service runs its own process.
"""

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

from lib3mrai.console import inf, no, ok
from lib3mrai.envfile import MissingCustomBox, set_custom_value

WHSEC_RE = re.compile(r"^whsec_[A-Za-z0-9]+$")
STRIPE_LOGIN_HINT = (
    "install the Stripe CLI and run `stripe login` against your local-dev "
    "sandbox — see docs/infrastructure/runbooks/stripe-sandbox-setup.md"
)
TIMEOUT_SECONDS = 30
DEFAULT_ENV_FILES = (".env.local.users", ".env.local.orders")


def service_for(env_file: str) -> str:
    """Map `.env.local.<service>` to its compose service name."""
    return Path(env_file).name.removeprefix(".env.local.")


def mask(secret: str) -> str:
    """Show enough to recognize the value without ever printing it whole."""
    if len(secret) <= 10:
        return "whsec_…"
    return f"{secret[:9]}…{secret[-2:]}"


def read_webhook_secret() -> str:
    """Run `stripe listen --print-secret` and return its whsec_ value.

    Never prints stdout: the raw output IS the secret. Failures surface only
    the CLI's stderr and the login hint.
    """
    try:
        result = subprocess.run(
            ["stripe", "listen", "--print-secret"],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"`stripe listen --print-secret` timed out after {TIMEOUT_SECONDS}s. "
            f"{STRIPE_LOGIN_HINT}"
        ) from exc

    secret = result.stdout.strip()
    if result.returncode != 0 or not WHSEC_RE.match(secret):
        stderr_summary = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "no stderr"
        raise RuntimeError(
            f"`stripe listen --print-secret` did not return a whsec_ value "
            f"({stderr_summary}). {STRIPE_LOGIN_HINT}"
        )
    return secret


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[4],
        help="repo root (defaults to four levels up from this script)",
    )
    parser.add_argument(
        "--env-file",
        action="append",
        dest="env_files",
        help="env file to update, relative to --repo-root; repeatable "
        f"(default: {' and '.join(DEFAULT_ENV_FILES)})",
    )
    args = parser.parse_args(argv[1:])
    env_files = args.env_files or list(DEFAULT_ENV_FILES)

    if shutil.which("stripe") is None:
        no(f"the Stripe CLI is not on PATH. {STRIPE_LOGIN_HINT}")
        return 1

    try:
        secret = read_webhook_secret()
    except RuntimeError as exc:
        no(str(exc))
        return 1

    for env_file in env_files:
        try:
            set_custom_value(args.repo_root / env_file, "STRIPE_WEBHOOK_SECRET", secret)
        except MissingCustomBox as exc:
            no(str(exc))
            return 1
        ok(f"wrote STRIPE_WEBHOOK_SECRET={mask(secret)} to {env_file}")

    services = " ".join(service_for(env_file) for env_file in env_files)
    inf(f"restart to pick it up: docker compose up -d {services}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
