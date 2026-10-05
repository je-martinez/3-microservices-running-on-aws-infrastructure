"""Decide pre-prod's Stripe and Geoapify integrations and feed every consumer.

CONTRACT: `.env.preprod` is the single source — Terraform (via the tfvars file),
the web build, the E2E env and the `stripe listen` forwarders all read it.
WARNING: Never print a key value; output names keys and says on/off, nothing else.
See [[2026-10-05-preprod-integrations-design]]
"""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
ENV_FILE = ROOT / ".env.preprod"
TFVARS = ROOT / "infra" / "environments" / "preprod" / "integrations.auto.tfvars.json"

FLAGS = ("STRIPE_ENABLED", "GEOAPIFY_ENABLED")
STRIPE_REQUIRED = ("STRIPE_SECRET_KEY_USERS", "STRIPE_SECRET_KEY_ORDERS", "STRIPE_PUBLISHABLE_KEY")
SECRET_KEYS = ("STRIPE_SECRET_KEY_USERS", "STRIPE_SECRET_KEY_ORDERS", "STRIPE_CLI_API_KEY")
SECRET_PREFIXES = ("sk_test_", "rk_test_")
AUTO_KEYS = ("STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_URL_TOKEN_USERS", "STRIPE_WEBHOOK_URL_TOKEN_ORDERS")


class IntegrationError(Exception):
    """A decision or derived value is missing; the message names it, never a value."""


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def parse(path: Path) -> dict[str, str]:
    """Every active KEY=VALUE in both boxes; comments and blank lines are skipped."""
    if not path.exists():
        return {}
    env: dict[str, str] = {}
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        env[key.strip()] = _unquote(value.strip())
    return env


def stripe_on(env: dict[str, str]) -> bool:
    return env.get("STRIPE_ENABLED") == "true"


def geoapify_on(env: dict[str, str]) -> bool:
    return env.get("GEOAPIFY_ENABLED") == "true"


def cli_api_key(env: dict[str, str]) -> str:
    """Empty means the developer's `stripe login` session — the identity dev uses too."""
    return env.get("STRIPE_CLI_API_KEY", "")


def cli_env(env: dict[str, str], base: dict[str, str] | None = None) -> dict[str, str]:
    """Environment for every `stripe` CLI call.

    CONTRACT: One identity for both forwarders and --print-secret, so both carry the
    signing secret Terraform deployed. A key goes in STRIPE_API_KEY, never argv (`ps`).
    """
    child = dict(os.environ if base is None else base)
    key = cli_api_key(env)
    if key:
        child["STRIPE_API_KEY"] = key
    return child


def undecided(env: dict[str, str]) -> list[str]:
    return [flag for flag in FLAGS if env.get(flag) not in ("true", "false")]


def problems(env: dict[str, str]) -> list[str]:
    out: list[str] = []
    if stripe_on(env):
        out += [f"STRIPE_ENABLED=true but {key} is empty" for key in STRIPE_REQUIRED if not env.get(key)]
    if geoapify_on(env) and not env.get("GEOAPIFY_API_KEY"):
        out.append("GEOAPIFY_ENABLED=true but GEOAPIFY_API_KEY is empty")
    for key in (*SECRET_KEYS, "STRIPE_PUBLISHABLE_KEY"):
        value = env.get(key, "")
        if not value:
            continue
        if "_live_" in value:
            out.append(f"{key} is a LIVE key — pre-prod accepts test keys only")
        elif key == "STRIPE_PUBLISHABLE_KEY" and not value.startswith("pk_test_"):
            out.append(f"{key} must start with pk_test_")
        elif key != "STRIPE_PUBLISHABLE_KEY" and not value.startswith(SECRET_PREFIXES):
            out.append(f"{key} must start with sk_test_ or rk_test_")
    return out


def tfvars(env: dict[str, str], auto: dict[str, str], cidrs: str) -> dict:
    on = stripe_on(env)
    return {
        "stripe_enabled": on,
        "geoapify_enabled": geoapify_on(env),
        "stripe_secret_key_users": env.get("STRIPE_SECRET_KEY_USERS", "") if on else "",
        "stripe_secret_key_orders": env.get("STRIPE_SECRET_KEY_ORDERS", "") if on else "",
        "stripe_webhook_secret": auto.get("STRIPE_WEBHOOK_SECRET", ""),
        "stripe_webhook_url_token_users": auto.get("STRIPE_WEBHOOK_URL_TOKEN_USERS", ""),
        "stripe_webhook_url_token_orders": auto.get("STRIPE_WEBHOOK_URL_TOKEN_ORDERS", ""),
        "stripe_webhook_allowed_cidrs": cidrs if on else "",
        "geoapify_api_key": env.get("GEOAPIFY_API_KEY", "") if geoapify_on(env) else "disabled",
    }


def summary(env: dict[str, str]) -> str:
    def state(on: bool) -> str:
        return "on" if on else "off"
    return f"Stripe: {state(stripe_on(env))} · Geoapify: {state(geoapify_on(env))}"
