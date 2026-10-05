"""Decide pre-prod's Stripe and Geoapify integrations and feed every consumer.

CONTRACT: `.env.preprod` is the single source — Terraform (via the tfvars file),
the web build, the E2E env and the `stripe listen` forwarders all read it.
WARNING: Never print a key value; output names keys and says on/off, nothing else.
See [[2026-10-05-preprod-integrations-design]]
"""

from __future__ import annotations

import argparse
import getpass
import importlib.util
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

from lib3mrai.console import inf, no, ok
from lib3mrai.envfile import AUTO_BEGIN, AUTO_END, CUSTOM_BEGIN, CUSTOM_END, set_custom_value, write_env_file

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


LOCAL_SCRIPTS = ROOT / "infra" / "environments" / "local" / "scripts"
HEADER = "Pre-prod integrations — make preprod-integrations. See docs/infrastructure/runbooks/preprod.md"
WHSEC_RE = re.compile(r"^whsec_[A-Za-z0-9]+$")
TIMEOUT_SECONDS = 30
CUSTOM_DEFAULTS = {key: "" for key in (
    "STRIPE_ENABLED", "STRIPE_SECRET_KEY_USERS", "STRIPE_SECRET_KEY_ORDERS",
    "STRIPE_PUBLISHABLE_KEY", "STRIPE_CLI_API_KEY", "GEOAPIFY_ENABLED", "GEOAPIFY_API_KEY")}
SKELETON = [
    "# Pre-prod only. Each *_ENABLED is true | false; empty means undecided and stops make preprod-up.",
    "# Test keys only — any *_live_ key is refused.",
    "STRIPE_ENABLED=",
    "# Users' restricted key (PaymentIntents: None) and Orders' (PaymentIntents: Write); one sk_test_ in both works too.",
    "STRIPE_SECRET_KEY_USERS=",
    "STRIPE_SECRET_KEY_ORDERS=",
    "STRIPE_PUBLISHABLE_KEY=",
    "# Optional. Empty = your `stripe login` session, which must be the SAME sandbox as the keys above.",
    "STRIPE_CLI_API_KEY=",
    "GEOAPIFY_ENABLED=",
    "GEOAPIFY_API_KEY=",
]


def write_private(path: Path, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(text)
    os.chmod(path, 0o600)


def create_skeleton(path: Path) -> None:
    write_private(path, "\n".join([f"# {HEADER}", AUTO_BEGIN, AUTO_END, "", CUSTOM_BEGIN, *SKELETON, CUSTOM_END, ""]))


def _yes(answer: str) -> bool:
    return answer.strip().lower().startswith(("y", "s"))


def prompt(env: dict[str, str], ask=input, ask_secret=getpass.getpass) -> dict[str, str]:
    """Ask for every undecided integration. Returns the updates; writes nothing, so an
    interrupted prompt leaves the file untouched."""
    updates: dict[str, str] = {}
    if env.get("STRIPE_ENABLED") not in ("true", "false"):
        if _yes(ask("  Enable Stripe in pre-prod? [y/n] ")):
            updates["STRIPE_ENABLED"] = "true"
            updates["STRIPE_SECRET_KEY_USERS"] = ask_secret("  Users secret key (rk_test_/sk_test_, hidden): ").strip()
            updates["STRIPE_SECRET_KEY_ORDERS"] = ask_secret("  Orders secret key (rk_test_/sk_test_, hidden): ").strip()
            updates["STRIPE_PUBLISHABLE_KEY"] = ask("  Publishable key (pk_test_): ").strip()
        else:
            updates["STRIPE_ENABLED"] = "false"
    if env.get("GEOAPIFY_ENABLED") not in ("true", "false"):
        if _yes(ask("  Enable Geoapify in pre-prod? [y/n] ")):
            updates["GEOAPIFY_ENABLED"] = "true"
            updates["GEOAPIFY_API_KEY"] = ask_secret("  Geoapify key (hidden): ").strip()
        else:
            updates["GEOAPIFY_ENABLED"] = "false"
    return updates


def read_webhook_secret(child_env: dict[str, str]) -> str:
    """`stripe listen --print-secret` under the CLI identity `cli_env` chose.

    WARNING: stdout IS the secret and stderr may echo the key — print neither.
    """
    try:
        result = subprocess.run(["stripe", "listen", "--print-secret"], capture_output=True, text=True,
                                timeout=TIMEOUT_SECONDS, env=child_env)
    except subprocess.TimeoutExpired as exc:
        raise IntegrationError(f"`stripe listen --print-secret` timed out after {TIMEOUT_SECONDS}s") from exc
    secret = result.stdout.strip()
    if result.returncode != 0 or not WHSEC_RE.match(secret):
        raise IntegrationError(
            "`stripe listen --print-secret` returned no whsec_ value — run `stripe login` against the "
            "same sandbox as your .env.preprod keys, or set STRIPE_CLI_API_KEY there")
    return secret


def regenerate_auto(env: dict[str, str], print_secret=read_webhook_secret) -> dict[str, str]:
    if not stripe_on(env):
        return {}
    return {
        "STRIPE_WEBHOOK_SECRET": print_secret(cli_env(env)),
        "STRIPE_WEBHOOK_URL_TOKEN_USERS": secrets.token_urlsafe(32),
        "STRIPE_WEBHOOK_URL_TOKEN_ORDERS": secrets.token_urlsafe(32),
    }


def current_auto(env: dict[str, str]) -> dict[str, str]:
    """The AUTO values already written. CONTRACT: Do NOT regenerate them here — a live
    pre-prod holds these tokens in Secrets Manager and in the running forwarders."""
    if not stripe_on(env):
        return {}
    auto = {key: env.get(key, "") for key in AUTO_KEYS}
    missing = [key for key, value in auto.items() if not value]
    if missing:
        raise IntegrationError(f"{', '.join(missing)} not generated yet — run `make preprod-up` "
                               "(Stripe needs a from-scratch pre-prod to mint its webhook values)")
    return auto


def stripe_webhook_cidrs() -> str:
    """Dev's allow-list (Stripe's IPs + private ranges), so both environments accept the same sources."""
    spec = importlib.util.spec_from_file_location("generate_env_files", LOCAL_SCRIPTS / "generate_env_files.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.STRIPE_WEBHOOK_ALLOWED_CIDRS


def run(*, env_file: Path, tfvars_path: Path, regenerate: bool, prompt_allowed: bool, stripe_off: bool,
        geoapify_off: bool, isatty=sys.stdin.isatty, ask=input, ask_secret=getpass.getpass,
        print_secret=read_webhook_secret, which=shutil.which, cidrs=stripe_webhook_cidrs) -> int:
    if not env_file.exists():
        create_skeleton(env_file)
        inf(f"created {env_file.name} — its CUSTOM box holds the pre-prod integration choices")
    if stripe_off:
        set_custom_value(env_file, "STRIPE_ENABLED", "false")
    if geoapify_off:
        set_custom_value(env_file, "GEOAPIFY_ENABLED", "false")

    env = parse(env_file)
    pending = undecided(env)
    if pending:
        if not (prompt_allowed and isatty()):
            no(f"undecided in {env_file.name}: {', '.join(pending)}")
            inf(f"    fill the CUSTOM box of {env_file} (true | false, plus the keys), then retry")
            inf("    or decline without asking: make preprod-up STRIPE=off GEOAPIFY=off")
            return 1
        for key, value in prompt(env, ask, ask_secret).items():
            set_custom_value(env_file, key, value)
        env = parse(env_file)

    issues = problems(env)
    for issue in issues:
        no(issue)
    if issues:
        return 1
    if stripe_on(env) and which("stripe") is None:
        no("Stripe is enabled but the Stripe CLI is not on PATH — install it: brew install stripe/stripe-cli/stripe")
        return 1

    try:
        auto = regenerate_auto(env, print_secret) if regenerate else current_auto(env)
    except IntegrationError as exc:
        no(str(exc))
        return 1

    write_env_file(env_file, header=HEADER, generated=auto, custom_defaults=CUSTOM_DEFAULTS)
    os.chmod(env_file, 0o600)
    write_private(tfvars_path, json.dumps(tfvars(env, auto, cidrs() if stripe_on(env) else ""), indent=2) + "\n")
    ok(summary(env))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Decide pre-prod's Stripe and Geoapify integrations.")
    parser.add_argument("--regenerate", action="store_true", help="mint new webhook secret/tokens (preprod-up only)")
    parser.add_argument("--no-prompt", action="store_true", help="validate only; never ask")
    parser.add_argument("--stripe-off", action="store_true")
    parser.add_argument("--geoapify-off", action="store_true")
    args = parser.parse_args(argv)
    return run(env_file=ENV_FILE, tfvars_path=TFVARS, regenerate=args.regenerate,
               prompt_allowed=not args.no_prompt, stripe_off=args.stripe_off, geoapify_off=args.geoapify_off)


if __name__ == "__main__":
    sys.exit(main())
