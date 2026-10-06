"""Run a command with the pre-prod endpoints and keys in its environment.

CONTRACT: Exec, never print `export` lines — API_GATEWAY_URL carries a literal
`$default` that a shell would expand. Pre-set values win in playwright.config.ts
(dotenv never overwrites), so stale dev `.env.local.*` files cannot leak in.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
from pathlib import Path

import preprod_integrations as pi

KEYS = ["api_gateway_url", "internal_api_key", "carrier_api_key", "e2e_query_token",
        "events_query_url", "ws_url", "notifications_queue_url", "events_topic_arn",
        "openobserve_root_password", "webhook_secret", "events_queue_url"]

OPENOBSERVE_USER = "admin@3mrai.local"

# The names e2e/support/stripe-webhook.ts, payment-element.ts and playwright.config.ts read.
STRIPE_VARS = ["STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_URL_TOKEN", "STRIPE_SECRET_KEY",
               "ORDERS_STRIPE_WEBHOOK_URL_TOKEN", "ORDERS_STRIPE_SECRET_KEY"]


def stripe_env(integrations: dict[str, str]) -> dict[str, str]:
    """CONTRACT: Blank, never omit, when Stripe is off — playwright.config.ts fills only
    UNSET names from `.env.local.*`, so an omitted name takes the dev sandbox value."""
    if not pi.stripe_on(integrations):
        return {name: "" for name in STRIPE_VARS}
    return {
        "STRIPE_SECRET_KEY": integrations["STRIPE_SECRET_KEY_USERS"],
        "ORDERS_STRIPE_SECRET_KEY": integrations["STRIPE_SECRET_KEY_ORDERS"],
        "STRIPE_WEBHOOK_SECRET": integrations["STRIPE_WEBHOOK_SECRET"],
        "STRIPE_WEBHOOK_URL_TOKEN": integrations["STRIPE_WEBHOOK_URL_TOKEN_USERS"],
        "ORDERS_STRIPE_WEBHOOK_URL_TOKEN": integrations["STRIPE_WEBHOOK_URL_TOKEN_ORDERS"],
    }


def env_from_outputs(o: dict[str, str], integrations: dict[str, str] | None = None) -> dict[str, str]:
    basic = base64.b64encode(f"{OPENOBSERVE_USER}:{o['openobserve_root_password']}".encode()).decode()
    return {
        "API_GATEWAY_URL": o["api_gateway_url"],
        "USERS_BASE_URL": "http://localhost:9101",
        "ORDERS_BASE_URL": "http://localhost:9102",
        "TRACKING_BASE_URL": "http://localhost:9103",
        "WEB_BASE_URL": "http://localhost:9090",
        "MAILPIT_API_URL": "http://localhost:8025/api/v1",
        "OPENOBSERVE_URL": "http://localhost:5080",
        "OPENOBSERVE_ORG": "3mrai",
        "OPENOBSERVE_USER": OPENOBSERVE_USER,
        "OPENOBSERVE_PASSWORD": o["openobserve_root_password"],
        "OPENOBSERVE_AUTH": f"Basic {basic}",
        "INTERNAL_API_KEY": o["internal_api_key"],
        "TRACKING_CARRIER_API_KEY": o["carrier_api_key"],
        "E2E_QUERY_TOKEN": o["e2e_query_token"],
        "EVENTS_QUERY_URL": o["events_query_url"],
        "WS_URL": o["ws_url"],
        "NOTIFICATIONS_QUEUE_URL": o["notifications_queue_url"],
        "EVENTS_TOPIC_ARN": o["events_topic_arn"],
        "EVENTS_QUEUE_URL": o["events_queue_url"],
        "WEBHOOK_SECRET": o["webhook_secret"],
        **stripe_env(integrations or {}),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tf-dir", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    raw = json.loads(subprocess.run(["terraform", f"-chdir={args.tf_dir}", "output", "-json"],
                                    capture_output=True, text=True, check=True).stdout)
    outputs = {k: raw[k]["value"] for k in KEYS}
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    env = env_from_outputs(outputs, pi.parse(pi.ENV_FILE))
    os.execvpe(command[0], command, {**os.environ, **env})
    return 0


if __name__ == "__main__":
    sys.exit(main())
