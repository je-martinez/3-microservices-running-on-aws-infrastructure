---
title: "Pre-Prod Integrations (Stripe + Geoapify Opt-In) Implementation Plan"
type: plan
area: infra
status: accepted
created: 2026-10-05
updated: 2026-10-05
tags:
  - type/plan
  - area/infra
  - status/accepted
propagates-to:
  - "[[ADR-0022-preprod-ecs-on-floci]]"
  - "[[preprod]]"
  - "[[env-files]]"
  - "[[stripe-sandbox-setup]]"
  - "[[2026-10-02-floci-preprod-environment-design]]"
  - "[[2026-10-05-preprod-integrations-design]]"
related:
  - "[[2026-10-05-preprod-integrations-design]]"
  - "[[2026-10-03-floci-preprod-follow-ups]]"
  - "[[preprod]]"
  - "[[env-files]]"
  - "[[stripe-sandbox-setup]]"
  - "[[ADR-0022-preprod-ecs-on-floci]]"
---

# Pre-Prod Integrations (Stripe + Geoapify Opt-In) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user opt in to a fully working Stripe flow and Geoapify autocomplete in the Floci pre-prod environment, or explicitly decline each, through a `.env.preprod` CUSTOM box.

**Architecture:** A single owner script (`preprod_integrations.py`) turns `.env.preprod` into a Terraform tfvars file and is the only reader every other consumer imports (`build_push.py`, `e2e_env.py`, `preprod_stripe_listen.py`, `preprod_doctor.py`). Terraform adds the Stripe SSM parameters and Secrets Manager entries only when enabled. The web image tag gains a config hash so toggling an integration rebuilds the bundle. Two background `stripe listen` processes forward webhooks to the ALB listeners.

**Tech Stack:** Python 3 (repo venv `.venv/bin/python`, pytest 8), Terraform (AWS provider against Floci), GNU Make, Stripe CLI 1.51+.

**Spec:** `docs/superpowers/specs/2026-10-05-preprod-integrations-design.md` ([[2026-10-05-preprod-integrations-design]]) — read it before starting.

---

## Resume here (this plan is self-contained)

The session that wrote this plan was cleared. Everything needed is below.

- **Execution method — chosen by the user on 2026-10-05: subagent-driven.** Use superpowers:subagent-driven-development: a fresh implementer subagent per task (`infra-impl` for Tasks 2-9, `obsidian-vault` for vault writes), a fresh reviewer after each, a whole-branch review at the end. Do not ask the user again which method to use.
- **Branch:** `feat/preprod-integrations`, cut from `feature/floci-preprod-env` and pushed. The spec is committed there (`7f860016`). PR target when done: `feature/floci-preprod-env` (NOT `main`).
- **Repo rules that bind every task** (from the root `CLAUDE.md`):
  - Converse with the user in **Spanish**; code, comments and vault notes in **English**.
  - **Git:** never commit, push or open a PR without the user choosing an option from the A/B/C/D/E menu rendered with the `AskUserQuestion` tool (labels without letter prefixes, clarification in parentheses, empty description). Dispatched subagents NEVER run git writes. Each "Commit" step below means: the main session summarises the diff, proposes the message, and shows the menu.
  - **Docs:** only the `obsidian-vault` subagent writes under `docs/`. Run `nvm use && node scripts/validate-vault.mjs` after vault edits.
  - **Node:** `nvm use` before any node/pnpm command. pnpm only, never npm.
  - **Python:** always the repo venv by absolute or repo-relative path: `.venv/bin/python`. `make scripts-setup` creates it.
  - **Comments:** closed tag set `CONTRACT:` / `WORKAROUND(<scope>):` / `WHY:` / `WARNING:` / `TODO(JE-<id>):`, present tense, ≤6 lines untagged, reference vault as `See [[note]]`. `make lint-comments` must stay "no new violations".
  - **Pre-prod and dev are mutually exclusive** (they share host port 4566). `make clean` / `make clean-state` refuse while pre-prod runs; `make preprod-down` refuses while dev runs; `make preprod-up` refuses without a TTY while dev runs. Bring one down before the other.
- **Run the pre-prod script tests:** `.venv/bin/python -m pytest -q infra/environments/preprod/scripts/tests` (44 pass on the base commit).
- **Never print, log, commit or paste a Stripe or Geoapify key value.** The agent never reads them either; it relies on the script's `Stripe: on · Geoapify: off` summary.

## Global Constraints

- Pre-prod only. Dev (`docker-compose.yml`, `.env.local.*`, `generate_env_files.py`) is unchanged.
- `.env.preprod` lives at the repo root, git-ignored by the existing `.env.*` rule, mode `600`, AUTO box + CUSTOM box per [[env-files]] using `lib3mrai.envfile` (`AUTO_BEGIN`, `AUTO_END`, `CUSTOM_BEGIN`, `CUSTOM_END`, `write_env_file`, `set_custom_value`).
- CUSTOM keys, exactly: `STRIPE_ENABLED`, `STRIPE_SECRET_KEY_USERS`, `STRIPE_SECRET_KEY_ORDERS`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_CLI_API_KEY` (optional), `GEOAPIFY_ENABLED`, `GEOAPIFY_API_KEY`.
- AUTO keys, exactly: `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_URL_TOKEN_USERS`, `STRIPE_WEBHOOK_URL_TOKEN_ORDERS` — present only when Stripe is on.
- `*_ENABLED` accept exactly `true` / `false`; anything else (including empty) is "undecided".
- Secret keys must start with `sk_test_` or `rk_test_`; the publishable key with `pk_test_`. Any value containing `_live_` is refused.
- Only `make preprod-up` regenerates the AUTO values (`--regenerate`). `preprod-deploy` runs `--no-prompt` and PRESERVES them.
- Terraform receives values only through `infra/environments/preprod/integrations.auto.tfvars.json` (mode `600`, git-ignored) — never on a command line.
- Web build args never carry a secret key or the Geoapify key. Web tag = `<base tag>-cfg<hash8>` (sha256 of its sorted build args); other services unchanged.
- Webhook listeners: users → `http://localhost:9101/v1/users/stripe/webhook/<token>`, orders → `http://localhost:9102/v1/orders/stripe/webhook/<token>`, events from `FORWARDS` in `infra/environments/local/scripts/set_stripe_webhook_secret.py`.
- **Stripe CLI identity:** both forwarders and `--print-secret` authenticate with the developer's `stripe login` session — the same one dev uses — unless `STRIPE_CLI_API_KEY` is set; then that key goes in the `STRIPE_API_KEY` environment variable, never `--api-key` (argv is visible in `ps`). One identity for both processes means one signing secret. The login must belong to the SAME Stripe sandbox as the keys in `.env.preprod`, or payments work while webhooks silently never arrive. The spec (§2, §8, Risks) already says this.

## Review Focus

1. **Quoted values pasted into the CUSTOM box** (`STRIPE_SECRET_KEY_USERS="rk_test_…"`) — a person expects them to work. Pinned in Task 2 (`test_parse_strips_matching_quotes`).
2. **Toggling Stripe on with pre-prod already up and running `make preprod-deploy`** — no AUTO values exist yet; the person expects a clear "run `make preprod-up`" message, not a Terraform error. Pinned in Task 3 (`test_no_prompt_without_auto_values_asks_for_preprod_up`).
3. **Ctrl-C in the middle of the prompt** — nothing half-written. Pinned in Task 3 (`test_interrupted_prompt_writes_nothing`).
4. **`make preprod-up` while old listeners from a crashed session still run** — they must be replaced, not reused with stale tokens. Pinned in Task 7 (`test_start_replaces_running_listeners`).
5. **`make preprod-down` with no listeners running** — must succeed silently. Pinned in Task 7 (`test_stop_without_listeners_succeeds`).

## File map

| File | Status | Responsibility |
|---|---|---|
| `infra/environments/preprod/scripts/preprod_integrations.py` | create | Read/decide/validate `.env.preprod`, prompt, regenerate AUTO, write tfvars. Public helpers other scripts import. |
| `infra/environments/preprod/scripts/tests/test_preprod_integrations.py` | create | Its tests. |
| `infra/environments/preprod/variables.tf` | modify | New integration variables. |
| `infra/environments/preprod/services.tf` | modify | Conditional Stripe params/secrets, Geoapify value. |
| `infra/environments/preprod/.gitignore` | modify | Ignore `integrations.auto.tfvars.json`. |
| `infra/environments/preprod/scripts/build_push.py` | modify | Web build args from `.env.preprod`, per-service tags with web `-cfg` suffix. |
| `infra/environments/preprod/scripts/tests/test_build_push.py` | modify | New tests. |
| `infra/environments/preprod/scripts/e2e_env.py` | modify | Stripe vars from `.env.preprod` when on. |
| `infra/environments/preprod/scripts/tests/test_e2e_env.py` | modify | New tests. |
| `infra/environments/preprod/scripts/preprod_stripe_listen.py` | create | start/stop/status of the two `stripe listen` processes. |
| `infra/environments/preprod/scripts/tests/test_preprod_stripe_listen.py` | create | Its tests. |
| `infra/environments/preprod/scripts/preprod_doctor.py` | modify | Listener check when Stripe is on. |
| `infra/environments/preprod/scripts/tests/test_preprod_doctor.py` | modify | New tests. |
| `Makefile` | modify | `preprod-integrations`, `preprod-stripe-listen`; wire into up/deploy/down. |
| `apps/web/nginx.conf` | modify | `"disabled"` placeholder counts as geocoding off. |
| `.env.example` | modify | `.env.preprod` block (committed contract). |
| `.claude/skills/local-env-lifecycle/SKILL.md` + `.ai/skills/local-env-lifecycle/SKILL.md` | modify | Agent rule + targets. |
| vault notes (via `obsidian-vault`) | modify | Propagation (Task 10). |

---

### Task 1: Confirm the Stripe CLI login matches the keys' sandbox (user-run, no code)

The forwarders use the developer's `stripe login` session by default. A session on a different sandbox than the keys in `.env.preprod` makes webhooks silently never arrive, so confirm it once. Never blocks Tasks 2-10.

- [x] **Step 1: Ask the user (in Spanish) to run this in THEIR OWN terminal** (account id and display name are not secrets, but the agent has no reason to see them):

```bash
stripe config --list | grep -E '^(display_name|account_id)'
```

and compare with the Stripe Dashboard of the sandbox where they created the `rk_test_…` keys (Settings → Business → Account details shows the account id). If it differs or the CLI is not logged in: `stripe login` (opens the browser) and pick that sandbox.

- [x] **Step 2: Record the answer** ("login matches" / "re-logged in"). `STRIPE_CLI_API_KEY` stays empty. It is only for a machine without `stripe login` (no browser) — then an `sk_test_…` of the same sandbox goes there. The login expires periodically (Stripe documents ~90 days); an expired one surfaces in Task 11 as the `--print-secret` error asking for `stripe login`.

---

### Task 2: `preprod_integrations.py` — pure helpers

**Files:**
- Create: `infra/environments/preprod/scripts/preprod_integrations.py`
- Create: `infra/environments/preprod/scripts/tests/test_preprod_integrations.py`

**Interfaces:**
- Produces (used by Tasks 3, 5, 6, 7, 8): `ENV_FILE: Path`, `TFVARS: Path`, `parse(path: Path) -> dict[str, str]`, `stripe_on(env) -> bool`, `geoapify_on(env) -> bool`, `cli_api_key(env) -> str`, `cli_env(env, base=None) -> dict[str, str]`, `undecided(env) -> list[str]`, `problems(env) -> list[str]`, `tfvars(env, auto, cidrs: str) -> dict`, `summary(env) -> str`, `class IntegrationError(Exception)`.

- [x] **Step 1: Write the failing tests**

```python
"""Tests for preprod_integrations.py — pure helpers."""

import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "preprod_integrations.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "infra" / "scripts"))
sys.path.insert(0, str(SCRIPT.parent))
_spec = importlib.util.spec_from_file_location("preprod_integrations", SCRIPT)
pi = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pi)

ON = {
    "STRIPE_ENABLED": "true",
    "STRIPE_SECRET_KEY_USERS": "rk_test_users",
    "STRIPE_SECRET_KEY_ORDERS": "rk_test_orders",
    "STRIPE_PUBLISHABLE_KEY": "pk_test_pub",
    "GEOAPIFY_ENABLED": "true",
    "GEOAPIFY_API_KEY": "geo_key",
}
AUTO = {
    "STRIPE_WEBHOOK_SECRET": "whsec_abc",
    "STRIPE_WEBHOOK_URL_TOKEN_USERS": "tok_u",
    "STRIPE_WEBHOOK_URL_TOKEN_ORDERS": "tok_o",
}


def test_parse_reads_both_boxes_and_skips_comments(tmp_path):
    f = tmp_path / ".env.preprod"
    f.write_text("# h\n# >>> AUTO\nA=1\n# <<< END\n\n# >>> CUSTOM\n# B=commented\nC=3\n# <<< END CUSTOM\n")
    assert pi.parse(f) == {"A": "1", "C": "3"}


def test_parse_strips_matching_quotes(tmp_path):
    f = tmp_path / ".env.preprod"
    f.write_text("A=\"rk_test_x\"\nB='pk_test_y'\nC=\"unbalanced\n")
    assert pi.parse(f) == {"A": "rk_test_x", "B": "pk_test_y", "C": "\"unbalanced"}


def test_parse_missing_file_is_empty(tmp_path):
    assert pi.parse(tmp_path / "nope") == {}


def test_undecided_lists_flags_not_true_or_false():
    assert pi.undecided({}) == ["STRIPE_ENABLED", "GEOAPIFY_ENABLED"]
    assert pi.undecided({"STRIPE_ENABLED": "yes", "GEOAPIFY_ENABLED": "false"}) == ["STRIPE_ENABLED"]
    assert pi.undecided(ON) == []


def test_enabled_with_missing_key_names_it():
    env = {**ON, "STRIPE_SECRET_KEY_ORDERS": ""}
    assert any("STRIPE_SECRET_KEY_ORDERS" in p for p in pi.problems(env))
    env = {**ON, "GEOAPIFY_API_KEY": ""}
    assert any("GEOAPIFY_API_KEY" in p for p in pi.problems(env))


def test_live_keys_are_refused():
    for key, value in [("STRIPE_SECRET_KEY_USERS", "sk_live_x"), ("STRIPE_PUBLISHABLE_KEY", "pk_live_x"),
                       ("STRIPE_CLI_API_KEY", "rk_live_x")]:
        problems = pi.problems({**ON, key: value})
        assert any(key in p and "LIVE" in p for p in problems), key


def test_wrong_prefix_is_refused():
    assert any("STRIPE_SECRET_KEY_USERS" in p for p in pi.problems({**ON, "STRIPE_SECRET_KEY_USERS": "pk_test_x"}))
    assert any("STRIPE_PUBLISHABLE_KEY" in p for p in pi.problems({**ON, "STRIPE_PUBLISHABLE_KEY": "rk_test_x"}))


def test_problems_never_echo_a_value():
    env = {**ON, "STRIPE_SECRET_KEY_USERS": "sk_live_SECRETVALUE"}
    assert all("SECRETVALUE" not in p for p in pi.problems(env))


def test_valid_config_has_no_problems():
    assert pi.problems(ON) == []
    assert pi.problems({"STRIPE_ENABLED": "false", "GEOAPIFY_ENABLED": "false"}) == []


def test_cli_uses_the_login_session_unless_a_cli_key_is_set():
    assert pi.cli_api_key(ON) == ""
    assert "STRIPE_API_KEY" not in pi.cli_env(ON, base={})
    assert pi.cli_env({**ON, "STRIPE_CLI_API_KEY": "sk_test_cli"}, base={})["STRIPE_API_KEY"] == "sk_test_cli"
    assert pi.cli_env(ON, base={"PATH": "/bin"}) == {"PATH": "/bin"}"


def test_tfvars_when_on():
    tv = pi.tfvars(ON, AUTO, "1.2.3.4,10.0.0.0/8")
    assert tv["stripe_enabled"] is True and tv["geoapify_enabled"] is True
    assert tv["stripe_secret_key_users"] == "rk_test_users"
    assert tv["stripe_secret_key_orders"] == "rk_test_orders"
    assert tv["stripe_webhook_secret"] == "whsec_abc"
    assert tv["stripe_webhook_url_token_users"] == "tok_u"
    assert tv["stripe_webhook_url_token_orders"] == "tok_o"
    assert tv["stripe_webhook_allowed_cidrs"] == "1.2.3.4,10.0.0.0/8"
    assert tv["geoapify_api_key"] == "geo_key"


def test_tfvars_when_off_carries_no_secret_and_the_geoapify_placeholder():
    env = {**ON, "STRIPE_ENABLED": "false", "GEOAPIFY_ENABLED": "false"}
    tv = pi.tfvars(env, {}, "")
    assert tv["stripe_enabled"] is False and tv["geoapify_enabled"] is False
    assert tv["stripe_secret_key_users"] == "" and tv["stripe_secret_key_orders"] == ""
    assert tv["geoapify_api_key"] == "disabled"


def test_summary_says_on_off_only():
    assert pi.summary(ON) == "Stripe: on · Geoapify: on"
    assert pi.summary({}) == "Stripe: off · Geoapify: off"
```

- [x] **Step 2: Run them to verify they fail**

Run: `.venv/bin/python -m pytest -q infra/environments/preprod/scripts/tests/test_preprod_integrations.py`
Expected: FAIL — `FileNotFoundError` / no module `preprod_integrations.py`.

- [x] **Step 3: Write the helpers** (top of the new file; Task 3 appends the I/O half)

```python
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
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/python -m pytest -q infra/environments/preprod/scripts/tests/test_preprod_integrations.py`
Expected: all PASS.

- [x] **Step 5: Commit** (main session, confirmation menu) — `feat(infra): parse and validate pre-prod integration choices`

---

### Task 3: `preprod_integrations.py` — prompt, skeleton, AUTO values, tfvars, CLI

**Files:**
- Modify: `infra/environments/preprod/scripts/preprod_integrations.py` (append)
- Modify: `infra/environments/preprod/scripts/tests/test_preprod_integrations.py` (append)

**Interfaces:**
- Consumes: Task 2 helpers.
- Produces: `run(*, env_file, tfvars_path, regenerate, prompt_allowed, stripe_off, geoapify_off, isatty, ask, ask_secret, print_secret, which, cidrs) -> int`; CLI `preprod_integrations.py [--regenerate] [--no-prompt] [--stripe-off] [--geoapify-off]` (exit 0 ok, 1 refused). Task 9 calls the CLI.

- [x] **Step 1: Append the failing tests**

```python
import json
import stat

import pytest

SECRETS = ["rk_test_USERSSECRET", "rk_test_ORDERSSECRET", "pk_test_PUBLISHABLE", "GEOSECRET", "whsec_WEBHOOKSECRET"]


def _run(tmp_path, **overrides):
    calls = {"ask": [], "secret": []}
    answers = iter(overrides.pop("answers", []))
    secret_answers = iter(overrides.pop("secret_answers", []))

    def ask(prompt):
        calls["ask"].append(prompt)
        return next(answers)

    def ask_secret(prompt):
        calls["secret"].append(prompt)
        return next(secret_answers)

    kwargs = dict(
        env_file=tmp_path / ".env.preprod",
        tfvars_path=tmp_path / "integrations.auto.tfvars.json",
        regenerate=True, prompt_allowed=True, stripe_off=False, geoapify_off=False,
        isatty=lambda: False, ask=ask, ask_secret=ask_secret,
        print_secret=lambda child_env: "whsec_WEBHOOKSECRET", which=lambda name: "/usr/bin/stripe",
        cidrs=lambda: "1.2.3.4",
    )
    kwargs.update(overrides)
    return pi.run(**kwargs), calls


def _write_custom(tmp_path, **values):
    _run(tmp_path)  # creates the skeleton (aborts: undecided)
    for key, value in values.items():
        pi.set_custom_value(tmp_path / ".env.preprod", key, value)


def test_missing_file_without_tty_creates_private_skeleton_and_aborts(tmp_path):
    rc, _ = _run(tmp_path)
    f = tmp_path / ".env.preprod"
    assert rc == 1 and f.exists()
    assert stat.S_IMODE(f.stat().st_mode) == 0o600
    assert "STRIPE_ENABLED=" in f.read_text() and pi.CUSTOM_BEGIN in f.read_text()
    assert not (tmp_path / "integrations.auto.tfvars.json").exists()


def test_off_flags_decide_without_asking(tmp_path):
    rc, calls = _run(tmp_path, stripe_off=True, geoapify_off=True)
    assert rc == 0 and calls["ask"] == []
    tv = json.loads((tmp_path / "integrations.auto.tfvars.json").read_text())
    assert tv["stripe_enabled"] is False and tv["geoapify_api_key"] == "disabled"


def test_tty_prompt_writes_choices_and_keys(tmp_path):
    rc, calls = _run(tmp_path, isatty=lambda: True,
                     answers=["y", "pk_test_PUBLISHABLE", "y"],
                     secret_answers=["rk_test_USERSSECRET", "rk_test_ORDERSSECRET", "GEOSECRET"])
    env = pi.parse(tmp_path / ".env.preprod")
    assert rc == 0
    assert env["STRIPE_ENABLED"] == "true" and env["STRIPE_SECRET_KEY_ORDERS"] == "rk_test_ORDERSSECRET"
    assert env["STRIPE_WEBHOOK_SECRET"] == "whsec_WEBHOOKSECRET"
    assert env["STRIPE_WEBHOOK_URL_TOKEN_USERS"] and env["STRIPE_WEBHOOK_URL_TOKEN_ORDERS"]
    assert env["STRIPE_WEBHOOK_URL_TOKEN_USERS"] != env["STRIPE_WEBHOOK_URL_TOKEN_ORDERS"]
    assert len(calls["secret"]) == 3


def test_no_prompt_flag_aborts_even_with_a_tty(tmp_path):
    rc, calls = _run(tmp_path, isatty=lambda: True, prompt_allowed=False)
    assert rc == 1 and calls["ask"] == []


def test_interrupted_prompt_writes_nothing(tmp_path):
    def boom(prompt):
        raise KeyboardInterrupt
    _run(tmp_path)  # skeleton
    before = (tmp_path / ".env.preprod").read_text()
    with pytest.raises(KeyboardInterrupt):
        _run(tmp_path, isatty=lambda: True, answers=["y"], ask_secret=boom)
    assert (tmp_path / ".env.preprod").read_text() == before


def test_enabled_with_missing_key_aborts_before_tfvars(tmp_path):
    _write_custom(tmp_path, STRIPE_ENABLED="true", GEOAPIFY_ENABLED="false")
    rc, _ = _run(tmp_path)
    assert rc == 1 and not (tmp_path / "integrations.auto.tfvars.json").exists()


def test_stripe_on_without_cli_aborts_before_tfvars(tmp_path):
    _write_custom(tmp_path, STRIPE_ENABLED="true", GEOAPIFY_ENABLED="false",
                  STRIPE_SECRET_KEY_USERS="rk_test_a", STRIPE_SECRET_KEY_ORDERS="rk_test_b",
                  STRIPE_PUBLISHABLE_KEY="pk_test_c")
    rc, _ = _run(tmp_path, which=lambda name: None)
    assert rc == 1 and not (tmp_path / "integrations.auto.tfvars.json").exists()


def _stripe_ready(tmp_path):
    _write_custom(tmp_path, STRIPE_ENABLED="true", GEOAPIFY_ENABLED="false",
                  STRIPE_SECRET_KEY_USERS="rk_test_a", STRIPE_SECRET_KEY_ORDERS="rk_test_b",
                  STRIPE_PUBLISHABLE_KEY="pk_test_c")


def test_no_prompt_preserves_auto_values(tmp_path):
    _stripe_ready(tmp_path)
    assert _run(tmp_path)[0] == 0
    first = pi.parse(tmp_path / ".env.preprod")
    assert _run(tmp_path, regenerate=False, prompt_allowed=False)[0] == 0
    second = pi.parse(tmp_path / ".env.preprod")
    for key in pi.AUTO_KEYS:
        assert first[key] == second[key]


def test_regenerate_rotates_url_tokens(tmp_path):
    _stripe_ready(tmp_path)
    _run(tmp_path)
    first = pi.parse(tmp_path / ".env.preprod")["STRIPE_WEBHOOK_URL_TOKEN_USERS"]
    _run(tmp_path)
    assert pi.parse(tmp_path / ".env.preprod")["STRIPE_WEBHOOK_URL_TOKEN_USERS"] != first


def test_no_prompt_without_auto_values_asks_for_preprod_up(tmp_path, capsys):
    _stripe_ready(tmp_path)
    rc, _ = _run(tmp_path, regenerate=False, prompt_allowed=False)
    assert rc == 1 and "make preprod-up" in capsys.readouterr().err


def test_custom_box_survives_regeneration(tmp_path):
    _stripe_ready(tmp_path)
    pi.set_custom_value(tmp_path / ".env.preprod", "MY_NOTE", "kept")
    _run(tmp_path)
    assert pi.parse(tmp_path / ".env.preprod")["MY_NOTE"] == "kept"


def test_tfvars_file_is_private(tmp_path):
    _run(tmp_path, stripe_off=True, geoapify_off=True)
    assert stat.S_IMODE((tmp_path / "integrations.auto.tfvars.json").stat().st_mode) == 0o600


def test_no_output_contains_a_key_value(tmp_path, capsys):
    _run(tmp_path, isatty=lambda: True,
         answers=["y", "pk_test_PUBLISHABLE", "y"],
         secret_answers=["rk_test_USERSSECRET", "rk_test_ORDERSSECRET", "GEOSECRET"])
    _run(tmp_path, regenerate=False, prompt_allowed=False)
    out = capsys.readouterr()
    for secret in SECRETS:
        assert secret not in out.out and secret not in out.err
```

- [x] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest -q infra/environments/preprod/scripts/tests/test_preprod_integrations.py`
Expected: the new tests FAIL with `AttributeError: module 'preprod_integrations' has no attribute 'run'`.

- [x] **Step 3: Append the implementation** (add these imports to the existing import block, then the code at the end of the file)

```python
# add to the imports at the top of the file:
import argparse
import getpass
import importlib.util
import json
import re
import secrets
import shutil
import subprocess
import sys

from lib3mrai.console import inf, no, ok
from lib3mrai.envfile import AUTO_BEGIN, AUTO_END, CUSTOM_BEGIN, CUSTOM_END, set_custom_value, write_env_file
```

```python
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
```

Note on `write_env_file`: it writes the AUTO header line `# >>> AUTO-GENERATED by \`make env-file\` — do not edit` (shared marker constant). Keep it — the marker text is what `read_custom_block` keys on; do not fork the constant.

> [!note] As built
> The marker now reads `# >>> AUTO-GENERATED — rewritten on every run, do not edit`, so it no longer names `make env-file` (pre-prod files are written by the preprod scripts). The prefix `# >>> AUTO-GENERATED` is unchanged and is what `read_custom_block` keys on.

- [x] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/python -m pytest -q infra/environments/preprod/scripts/tests/test_preprod_integrations.py`
Expected: all PASS.

- [x] **Step 5: Run the whole pre-prod suite and the comment linter**

Run: `.venv/bin/python -m pytest -q infra/environments/preprod/scripts/tests && make lint-comments`
Expected: all pass; "OK — no new violations".

- [x] **Step 6: Commit** (main session, confirmation menu) — `feat(infra): decide pre-prod integrations from a .env.preprod CUSTOM box`

---

### Task 4: Terraform — variables, conditional Stripe config, Geoapify value

**Files:**
- Modify: `infra/environments/preprod/variables.tf` (replace the `geoapify_api_key` block at the end; append new variables)
- Modify: `infra/environments/preprod/services.tf` (locals `parameters.users`, `parameters.orders`, `secrets.users`, `secrets.orders`, `secrets.web`)
- Modify: `infra/environments/preprod/.gitignore`
- Modify: `apps/web/nginx.conf` (the `$geoapify_disabled` map)

**Interfaces:**
- Consumes: the tfvars keys written by Task 3: `stripe_enabled`, `geoapify_enabled`, `stripe_secret_key_users`, `stripe_secret_key_orders`, `stripe_webhook_secret`, `stripe_webhook_url_token_users`, `stripe_webhook_url_token_orders`, `stripe_webhook_allowed_cidrs`, `geoapify_api_key`.

- [x] **Step 1: Replace the `geoapify_api_key` block in `variables.tf` and append the new variables**

```hcl
# WHY: Plain bools — they decide which SSM/Secrets entries exist, and for_each keys
# cannot be sensitive. preprod_integrations.py writes all of these to
# integrations.auto.tfvars.json. See [[2026-10-05-preprod-integrations-design]]
variable "stripe_enabled" {
  type    = bool
  default = false
}

variable "geoapify_enabled" {
  type    = bool
  default = false
}

variable "stripe_secret_key_users" {
  type      = string
  default   = ""
  sensitive = true
}

variable "stripe_secret_key_orders" {
  type      = string
  default   = ""
  sensitive = true
}

variable "stripe_webhook_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "stripe_webhook_url_token_users" {
  type      = string
  default   = ""
  sensitive = true
}

variable "stripe_webhook_url_token_orders" {
  type      = string
  default   = ""
  sensitive = true
}

variable "stripe_webhook_allowed_cidrs" {
  type        = string
  default     = ""
  description = "Stripe's webhook IPs plus private ranges; the same list as dev's generate_env_files.py."
}

# WHY: nginx refuses to start with GEOAPIFY_API_KEY undefined, and Secrets Manager
# rejects empty values, so "disabled" is the off state.
variable "geoapify_api_key" {
  type        = string
  default     = "disabled"
  sensitive   = true
  description = "Geoapify key for the web /geocode/ proxy; only used when geoapify_enabled."
}
```

- [x] **Step 2: Edit `services.tf` locals**

Add, inside `locals { … }` right after `users_grpc_url = …`:

```hcl
  # CONTRACT: Stripe entries exist ONLY when enabled — Secrets Manager rejects empty
  # values, and a for-expression (not a ternary) keeps the object types consistent.
  stripe_parameters = { for k, v in {
    STRIPE_WEBHOOK_ALLOWED_CIDRS      = var.stripe_webhook_allowed_cidrs
    STRIPE_WEBHOOK_TRUSTED_PROXY_HOPS = "0"
  } : k => v if var.stripe_enabled }
```

In `parameters.users`: change `STRIPE_ENABLED          = "false"` to `STRIPE_ENABLED          = tostring(var.stripe_enabled)` and add `local.stripe_parameters` as the LAST argument of its `merge(...)`: `users = merge(local.aws_common, local.otel_common, { … }, local.stripe_parameters)`.

In `parameters.orders`: same — `STRIPE_ENABLED              = tostring(var.stripe_enabled)` and `orders = merge(local.aws_common, { … }, local.stripe_parameters)`.

In `secrets.users`, wrap the existing map:

```hcl
    users = merge({
      DATABASE_WRITER_URL = "postgres://${var.db_username}:${var.db_password}@floci:${local.pg_port}/users"
      DATABASE_READER_URL = "postgres://${var.db_username}:${var.db_password}@floci:${local.pg_port}/users"
      WEBHOOK_SECRET      = random_password.webhook_secret.result
      INTERNAL_API_KEY    = random_password.internal_api_key.result
      }, { for k, v in {
        STRIPE_SECRET_KEY        = var.stripe_secret_key_users
        STRIPE_WEBHOOK_SECRET    = var.stripe_webhook_secret
        STRIPE_WEBHOOK_URL_TOKEN = var.stripe_webhook_url_token_users
    } : k => v if var.stripe_enabled })
```

In `secrets.orders`, the same shape with `var.stripe_secret_key_orders` and `var.stripe_webhook_url_token_orders` (keep its existing three entries unchanged inside the first map).

In `secrets.web`: `GEOAPIFY_API_KEY = var.geoapify_enabled ? var.geoapify_api_key : "disabled"`.

- [x] **Step 3: Ignore the tfvars file** — append to `infra/environments/preprod/.gitignore`:

```
integrations.auto.tfvars.json
```

- [x] **Step 4: Make nginx treat the `"disabled"` placeholder as OFF** — `apps/web/nginx.conf` decides "geocoding off" only on an EMPTY key (`map $geoapify_key $geoapify_disabled { "" 1; default 0; }`, ~line 33). With pre-prod's placeholder it would proxy `apiKey=disabled` to Geoapify, get a 401 and burn free-tier quota instead of answering 503. Change that map to:

```nginx
map $geoapify_key $geoapify_disabled {
    ""         1;
    # CONTRACT: Pre-prod's off state — Secrets Manager rejects an empty value.
    "disabled" 1;
    default    0;
}
```

Dev never sets `disabled`, so dev behaviour is unchanged. Verify syntax: `docker run --rm -v "$PWD/apps/web/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:alpine nginx -t` — if it fails only on unresolved `${…}` envsubst placeholders or upstream names, that is the template, not your edit; compare against the same command on `git stash`ed code. *(Drift: a plan defect, workers never run git writes; compare against the unedited file instead.)*

- [x] **Step 5: Validate and format**

Run:
```bash
terraform fmt infra/environments/preprod && \
terraform -chdir=infra/environments/preprod init -backend=false -input=false >/dev/null && \
terraform -chdir=infra/environments/preprod validate && \
git check-ignore -v infra/environments/preprod/integrations.auto.tfvars.json
```
Expected: `Success! The configuration is valid.` and the ignore rule printed. (`init -backend=false` creates `.terraform/`; `make preprod-down` deletes it — harmless.)

- [x] **Step 6: Commit** (main session, confirmation menu) — `feat(infra): wire pre-prod Stripe and Geoapify values through Terraform`

---

### Task 5: `build_push.py` — web build args from `.env.preprod`, `-cfg` tag suffix

**Files:**
- Modify: `infra/environments/preprod/scripts/build_push.py`
- Modify: `infra/environments/preprod/scripts/tests/test_build_push.py`

**Interfaces:**
- Consumes: `preprod_integrations.parse`, `ENV_FILE`, `stripe_on`, `geoapify_on`.
- Produces: `web_build_args(ws_url: str, env: dict) -> dict[str, str]`, `config_suffix(build_args: dict) -> str`, `service_tag(service: str, base: str, build_args: dict) -> str`.

- [x] **Step 1: Append the failing tests** to `test_build_push.py` (also add `sys.path.insert(0, str(SCRIPT.parent))` right after the existing `sys.path.insert(...)` line at the top, so the script's `import preprod_integrations` resolves)

```python
STRIPE_ON = {"STRIPE_ENABLED": "true", "STRIPE_PUBLISHABLE_KEY": "pk_test_pub",
             "STRIPE_SECRET_KEY_USERS": "rk_test_u", "STRIPE_SECRET_KEY_ORDERS": "rk_test_o",
             "GEOAPIFY_ENABLED": "true", "GEOAPIFY_API_KEY": "geo_secret"}


def test_web_build_args_follow_integrations():
    on = bp.web_build_args("ws://w", STRIPE_ON)
    assert on["NG_APP_STRIPE_ENABLED"] == "true" and on["NG_APP_STRIPE_PUBLISHABLE_KEY"] == "pk_test_pub"
    assert on["NG_APP_GEOCODE_ENABLED"] == "true" and on["NG_APP_WS_URL"] == "ws://w"
    off = bp.web_build_args("ws://w", {})
    assert off["NG_APP_STRIPE_ENABLED"] == "false" and off["NG_APP_STRIPE_PUBLISHABLE_KEY"] == ""
    assert off["NG_APP_GEOCODE_ENABLED"] == "false"


def test_web_build_args_never_carry_secret_keys():
    values = set(bp.web_build_args("ws://w", STRIPE_ON).values())
    assert not values & {"rk_test_u", "rk_test_o", "geo_secret"}


def test_web_tag_changes_with_its_build_args_and_is_stable():
    on, off = bp.web_build_args("ws://w", STRIPE_ON), bp.web_build_args("ws://w", {})
    assert bp.service_tag("web", "abc", on) != bp.service_tag("web", "abc", off)
    assert bp.service_tag("web", "abc", on) == bp.service_tag("web", "abc", dict(reversed(list(on.items()))))
    assert bp.service_tag("web", "abc", on).startswith("abc-cfg")


def test_only_web_gets_the_config_suffix():
    assert bp.service_tag("users", "abc", {"X": "1"}) == "abc"
```

- [x] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest -q infra/environments/preprod/scripts/tests/test_build_push.py`
Expected: FAIL with `AttributeError: ... no attribute 'web_build_args'`.

- [x] **Step 3: Implement**

Add `import preprod_integrations as pi` after the `from lib3mrai...` imports. Add below `image_tag`:

```python
def web_build_args(ws_url: str, env: dict[str, str]) -> dict[str, str]:
    """CONTRACT: Never a secret key or the Geoapify key — every NG_APP_* is readable in the bundle."""
    stripe = pi.stripe_on(env)
    return {
        "NG_APP_API_GATEWAY_URL": "/v1",
        "NG_APP_WS_URL": ws_url,
        "NG_APP_STRIPE_ENABLED": "true" if stripe else "false",
        "NG_APP_STRIPE_PUBLISHABLE_KEY": env.get("STRIPE_PUBLISHABLE_KEY", "") if stripe else "",
        "NG_APP_GEOCODE_ENABLED": "true" if pi.geoapify_on(env) else "false",
        "NG_APP_RUM_ENABLED": "true",
    }


def config_suffix(build_args: dict[str, str]) -> str:
    digest = hashlib.sha256(json.dumps(sorted(build_args.items())).encode()).hexdigest()
    return f"-cfg{digest[:8]}"


def service_tag(service: str, base: str, build_args: dict[str, str]) -> str:
    """CONTRACT: Web's tag carries its build args — a clean tree tags by SHA alone and a
    tag already in ECR is never rebuilt, so a toggled integration would ship the old bundle."""
    return base + config_suffix(build_args) if service == "web" else base
```

Replace `_build_args`:

```python
def _build_args(service: str, tf_dir: Path, env: dict[str, str]) -> dict[str, str]:
    if service == "web":
        return web_build_args(terraform_output(tf_dir, "ws_url"), env)
    if service == "orders":
        has_cache = subprocess.run(["docker", "image", "inspect", "3mrai-nuget-cache:latest"],
                                   capture_output=True).returncode == 0
        return {"SDK_IMAGE": "3mrai-nuget-cache:latest"} if has_cache else {}
    return {}
```

In `main`, after `tag = image_tag(...)` and the `_ecr_login(...)` line, replace everything from `ecr = client("ecr")` to the `update_tags(...)` call with:

```python
    env = pi.parse(pi.ENV_FILE)
    build_args = {s: _build_args(s, args.tf_dir, env) for s in services}
    tags = {s: service_tag(s, tag, build_args[s]) for s in services}

    ecr = client("ecr")
    to_push = services_to_push(services, lambda s: tag_in_ecr(ecr, repository_name(urls[s]), tags[s]))
    for service in services:
        if service not in to_push:
            inf(f"    {service}:{tags[service]} already in ECR - recording the tag, nothing built")
            continue
        inf(f"    {service} → {urls[service]}:{tags[service]}")
        for cmd in commands_for(service, urls[service], tags[service], build_args[service]):
            subprocess.run(cmd, cwd=ROOT, check=True)
        ok(f"pushed {service}:{tags[service]}")

    update_tags(args.tf_dir / "image-tags.auto.tfvars.json", tags)
    return 0
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/python -m pytest -q infra/environments/preprod/scripts/tests`
Expected: all PASS (old build_push tests included).

- [x] **Step 5: Commit** (main session, confirmation menu) — `feat(infra): build the pre-prod web bundle from the chosen integrations`

---

### Task 6: `e2e_env.py` — Stripe vars from `.env.preprod` when on

**Files:**
- Modify: `infra/environments/preprod/scripts/e2e_env.py`
- Modify: `infra/environments/preprod/scripts/tests/test_e2e_env.py`

**Interfaces:**
- Consumes: `preprod_integrations.parse`, `ENV_FILE`, `stripe_on`.
- Produces: `stripe_env(integrations: dict) -> dict[str, str]`; `env_from_outputs(o, integrations=None)`.

- [x] **Step 1: Append the failing tests** (and add `sys.path.insert(0, str(SCRIPT.parent))` after the existing `sys.path.insert(...)`)

```python
ON = {"STRIPE_ENABLED": "true", "STRIPE_SECRET_KEY_USERS": "rk_test_u", "STRIPE_SECRET_KEY_ORDERS": "rk_test_o",
      "STRIPE_WEBHOOK_SECRET": "whsec_x", "STRIPE_WEBHOOK_URL_TOKEN_USERS": "tu",
      "STRIPE_WEBHOOK_URL_TOKEN_ORDERS": "to"}


def test_stripe_on_feeds_each_service_its_own_values():
    env = ee.env_from_outputs(OUTPUTS, ON)
    assert env["STRIPE_SECRET_KEY"] == "rk_test_u" and env["ORDERS_STRIPE_SECRET_KEY"] == "rk_test_o"
    assert env["STRIPE_WEBHOOK_SECRET"] == "whsec_x"
    assert env["STRIPE_WEBHOOK_URL_TOKEN"] == "tu" and env["ORDERS_STRIPE_WEBHOOK_URL_TOKEN"] == "to"


def test_stripe_off_in_the_file_still_blanks_every_var():
    env = ee.env_from_outputs(OUTPUTS, {**ON, "STRIPE_ENABLED": "false"})
    assert all(env[name] == "" for name in ee.STRIPE_VARS)
```

- [x] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest -q infra/environments/preprod/scripts/tests/test_e2e_env.py`
Expected: FAIL — `env_from_outputs() takes 1 positional argument but 2 were given`.

- [x] **Step 3: Implement**

Add `import preprod_integrations as pi` after the stdlib imports. Add above `env_from_outputs`:

```python
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
```

Change the signature to `def env_from_outputs(o: dict[str, str], integrations: dict[str, str] | None = None) -> dict[str, str]:`, delete the 3-line `# CONTRACT: Pre-prod has Stripe disabled…` comment and replace `**{name: "" for name in STRIPE_VARS},` with `**stripe_env(integrations or {}),`.

In `main`, change the exec line to:

```python
    env = env_from_outputs(outputs, pi.parse(pi.ENV_FILE))
    os.execvpe(command[0], command, {**os.environ, **env})
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/python -m pytest -q infra/environments/preprod/scripts/tests`
Expected: all PASS (the existing `test_stripe_vars_are_blanked_so_dev_env_files_cannot_leak_in` still passes through the default).

- [x] **Step 5: Commit** (main session, confirmation menu) — `feat(infra): feed pre-prod E2E the Stripe values when Stripe is on`

---

### Task 7: `preprod_stripe_listen.py` — background forwarders

**Files:**
- Create: `infra/environments/preprod/scripts/preprod_stripe_listen.py`
- Create: `infra/environments/preprod/scripts/tests/test_preprod_stripe_listen.py`

**Interfaces:**
- Consumes: `preprod_integrations.parse`, `ENV_FILE`, `stripe_on`, `cli_env`; `FORWARDS` from `infra/environments/local/scripts/set_stripe_webhook_secret.py` (`{"users": (3000, "<events>"), "orders": (3001, "<events>")}` — only the events are used).
- Produces: CLI `preprod_stripe_listen.py {start|stop|status}` (status exit 1 when a listener is down). Functions `command(service, env)`, `start(env, spawn)`, `stop()`, `status()`.

- [x] **Step 1: Write the failing tests**

```python
"""Tests for preprod_stripe_listen.py."""

import importlib.util
import os
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "preprod_stripe_listen.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "infra" / "scripts"))
sys.path.insert(0, str(SCRIPT.parent))
_spec = importlib.util.spec_from_file_location("preprod_stripe_listen", SCRIPT)
sl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sl)

ON = {"STRIPE_ENABLED": "true", "STRIPE_SECRET_KEY_USERS": "rk_test_USERKEY",
      "STRIPE_WEBHOOK_URL_TOKEN_USERS": "TOKU", "STRIPE_WEBHOOK_URL_TOKEN_ORDERS": "TOKO"}
WITH_CLI_KEY = {**ON, "STRIPE_CLI_API_KEY": "sk_test_CLIKEY"}


class FakeProcess:
    # WARNING: a live pid so `running()` sees it — it is pytest's own. Never let a test
    # call the real `stop()` with these pid files, or it SIGTERMs the test run.
    pid = os.getpid()


def test_command_forwards_to_the_alb_listener_with_dev_events():
    cmd = sl.command("users", ON)
    assert cmd[:2] == ["stripe", "listen"]
    assert cmd[cmd.index("--events") + 1] == sl.forwards()["users"][1]
    assert cmd[cmd.index("--forward-to") + 1] == "http://localhost:9101/v1/users/stripe/webhook/TOKU"
    assert sl.command("orders", ON)[-1] == "http://localhost:9102/v1/orders/stripe/webhook/TOKO"


def test_no_key_ever_goes_in_argv():
    for part in sl.command("users", WITH_CLI_KEY):
        assert "rk_test_USERKEY" not in part and "sk_test_CLIKEY" not in part


def test_start_is_a_no_op_when_stripe_is_off(tmp_path, monkeypatch):
    monkeypatch.setattr(sl, "LOG_DIR", tmp_path)
    spawned = []
    assert sl.start({}, spawn=lambda *a, **k: spawned.append(a)) == 0
    assert spawned == []


def test_start_uses_the_login_session_unless_a_cli_key_is_set(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(sl, "LOG_DIR", tmp_path)
    monkeypatch.setattr(sl, "stop", lambda: 0)  # pid files hold pytest's own pid — see FakeProcess
    monkeypatch.delenv("STRIPE_API_KEY", raising=False)
    seen = []

    def spawn(cmd, **kwargs):
        seen.append(kwargs["env"].get("STRIPE_API_KEY"))
        return FakeProcess()

    assert sl.start(ON, spawn=spawn) == 0
    assert seen == [None, None]
    out = capsys.readouterr().out
    assert "TOKU" not in out and "TOKO" not in out and "<token>" in out
    assert (tmp_path / "users.pid").exists() and (tmp_path / "orders.pid").exists()

    seen.clear()
    assert sl.start(WITH_CLI_KEY, spawn=spawn) == 0
    assert seen == ["sk_test_CLIKEY", "sk_test_CLIKEY"]


def test_start_replaces_running_listeners(tmp_path, monkeypatch):
    monkeypatch.setattr(sl, "LOG_DIR", tmp_path)
    stopped = []
    monkeypatch.setattr(sl, "stop", lambda: stopped.append(True) or 0)
    sl.start(ON, spawn=lambda cmd, **k: FakeProcess())
    assert stopped == [True]


def test_stop_without_listeners_succeeds(tmp_path, monkeypatch):
    monkeypatch.setattr(sl, "LOG_DIR", tmp_path)
    assert sl.stop() == 0


def test_status_fails_when_a_listener_is_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(sl, "LOG_DIR", tmp_path)
    (tmp_path / "users.pid").write_text(str(os.getpid()))
    assert sl.status() == 1
    (tmp_path / "orders.pid").write_text(str(os.getpid()))
    assert sl.status() == 0
```

- [x] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest -q infra/environments/preprod/scripts/tests/test_preprod_stripe_listen.py`
Expected: FAIL — script not found.

- [x] **Step 3: Implement**

```python
#!/usr/bin/env python3
"""Run one `stripe listen` per service, forwarding pre-prod webhooks to its ALB listener.

CONTRACT: One process per service — --forward-to takes a single URL. Both run under
ONE CLI identity (`cli_env`: the `stripe login` session, or STRIPE_CLI_API_KEY), so
both carry the signing secret Terraform deployed.
WARNING: Messages show <token>, never the URL token. See [[2026-10-05-preprod-integrations-design]]
"""

from __future__ import annotations

import importlib.util
import os
import signal
import subprocess
import sys
from pathlib import Path

import preprod_integrations as pi
from lib3mrai.console import inf, no, ok

ROOT = Path(__file__).resolve().parents[4]
LOG_DIR = ROOT / "logs" / "preprod-stripe"
PORTS = {"users": 9101, "orders": 9102}
SECRET_SCRIPT = ROOT / "infra" / "environments" / "local" / "scripts" / "set_stripe_webhook_secret.py"
MAX_BYTES = 2 * 1024 * 1024


def forwards() -> dict[str, tuple[int, str]]:
    """Dev's per-service event lists — one source, so both environments subscribe alike."""
    spec = importlib.util.spec_from_file_location("set_stripe_webhook_secret", SECRET_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.FORWARDS


def command(service: str, env: dict[str, str]) -> list[str]:
    token = env[f"STRIPE_WEBHOOK_URL_TOKEN_{service.upper()}"]
    return ["stripe", "listen", "--events", forwards()[service][1],
            "--forward-to", f"http://localhost:{PORTS[service]}/v1/{service}/stripe/webhook/{token}"]


def pid_file(service: str) -> Path:
    return LOG_DIR / f"{service}.pid"


def log_file(service: str) -> Path:
    return LOG_DIR / f"{service}.log"


def running(service: str) -> int | None:
    try:
        pid = int(pid_file(service).read_text().strip())
        os.kill(pid, 0)
        return pid
    except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError):
        return None


def stop() -> int:
    for service in PORTS:
        pid = running(service)
        if pid:
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
            inf(f"{service}: stripe listen stopped (pid {pid})")
        pid_file(service).unlink(missing_ok=True)
    return 0


def start(env: dict[str, str], spawn=subprocess.Popen) -> int:
    if not pi.stripe_on(env):
        inf("Stripe is off in .env.preprod — no webhook forwarders started")
        return 0
    stop()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    child_env = pi.cli_env(env)
    for service, port in PORTS.items():
        log = log_file(service)
        if log.exists() and log.stat().st_size > MAX_BYTES:
            log.replace(log.with_suffix(".log.1"))
        with log.open("a") as handle:
            process = spawn(command(service, env), cwd=ROOT, stdout=handle, stderr=subprocess.STDOUT,
                            start_new_session=True, env=child_env)
        pid_file(service).write_text(str(process.pid))
        ok(f"{service}: forwarding → localhost:{port}/v1/{service}/stripe/webhook/<token> "
           f"(pid {process.pid}, logs/preprod-stripe/{service}.log)")
    return 0


def status() -> int:
    down = [service for service in PORTS if not running(service)]
    for service in PORTS:
        if service in down:
            no(f"{service}: stripe listen is not running - make preprod-stripe-listen")
        else:
            ok(f"{service}: stripe listen running (pid {running(service)})")
    return 1 if down else 0


def main(argv: list[str]) -> int:
    action = argv[1] if len(argv) > 1 else ""
    if action == "start":
        return start(pi.parse(pi.ENV_FILE))
    if action == "stop":
        return stop()
    if action == "status":
        return status()
    no("usage: preprod_stripe_listen.py start|stop|status")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/python -m pytest -q infra/environments/preprod/scripts/tests`
Expected: all PASS.

- [x] **Step 5: Commit** (main session, confirmation menu) — `feat(infra): run the pre-prod Stripe webhook forwarders in the background`

---

### Task 8: `preprod_doctor.py` — listener check

**Files:**
- Modify: `infra/environments/preprod/scripts/preprod_doctor.py`
- Modify: `infra/environments/preprod/scripts/tests/test_preprod_doctor.py`

**Interfaces:**
- Consumes: `preprod_integrations.parse/ENV_FILE/stripe_on`; CLI `preprod_stripe_listen.py status` (Task 7); existing `run_check(script, *args) -> int`.
- Produces: `stripe_listener_failures(env, check=run_check) -> int`.

- [x] **Step 1: Append the failing tests** (ensure the test file inserts `SCRIPT.parent` into `sys.path` before `exec_module`, like Tasks 5-6; read the file's header first and keep its existing loading code)

```python
def test_listener_check_skipped_when_stripe_is_off():
    called = []
    assert pd.stripe_listener_failures({}, check=lambda *a: called.append(a) or 0) == 0
    assert called == []


def test_listener_check_counts_a_down_listener():
    assert pd.stripe_listener_failures({"STRIPE_ENABLED": "true"}, check=lambda *a: 1) == 1
    assert pd.stripe_listener_failures({"STRIPE_ENABLED": "true"}, check=lambda *a: 0) == 0
```

(If the module alias in that test file is not `pd`, use the alias it already defines.)

- [x] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest -q infra/environments/preprod/scripts/tests/test_preprod_doctor.py`
Expected: FAIL — no attribute `stripe_listener_failures`.

- [x] **Step 3: Implement** — add `import preprod_integrations as pi` with the other imports (after the `sys.path.insert(...)` line), add the function above `main`, and call it in `main` just before `return 1 if failures else 0`:

```python
def stripe_listener_failures(env: dict[str, str], check=run_check) -> int:
    """Both forwarders must be alive when Stripe is on; a dead one silently drops webhooks."""
    if not pi.stripe_on(env):
        return 0
    return 1 if check("preprod_stripe_listen.py", "status") else 0
```

```python
    failures += stripe_listener_failures(pi.parse(pi.ENV_FILE))
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/python -m pytest -q infra/environments/preprod/scripts/tests`
Expected: all PASS.

- [x] **Step 5: Commit** (main session, confirmation menu) — `feat(infra): preprod-doctor checks the Stripe webhook forwarders`

---

### Task 9: Makefile wiring

**Files:**
- Modify: `Makefile` (the `## ── Pre-production` block)

**Interfaces:**
- Consumes: CLIs from Tasks 3 and 7.

- [x] **Step 1: Add the flags variable** after `PP_ALIASES := …`:

```make
PP_INTEGRATION_FLAGS := $(if $(filter off,$(STRIPE)),--stripe-off) $(if $(filter off,$(GEOAPIFY)),--geoapify-off)
```

Add `preprod-integrations preprod-stripe-listen` to the `.PHONY:` line of that block.

- [x] **Step 2: Add the two targets** (after `preprod-aliases`):

```make
preprod-integrations: scripts-setup ## Pre-prod: decide Stripe/Geoapify in .env.preprod (STRIPE=off GEOAPIFY=off to decline)
	$(PY) $(PP_TF_DIR)/scripts/preprod_integrations.py $(PP_INTEGRATION_FLAGS)

preprod-stripe-listen: scripts-setup ## Pre-prod: (re)start the two stripe listen webhook forwarders
	$(PY) $(PP_TF_DIR)/scripts/preprod_stripe_listen.py start
```

- [x] **Step 3: Wire `preprod-up`** — insert right after the `preprod_live.py` line, and append one line at the very end of the recipe:

```make
	@# CONTRACT: After preprod_live — --regenerate mints new webhook tokens, which a LIVE
	@# pre-prod would no longer match. See [[2026-10-05-preprod-integrations-design]]
	$(PY) $(PP_TF_DIR)/scripts/preprod_integrations.py --regenerate $(PP_INTEGRATION_FLAGS)
```

```make
	$(PY) $(PP_TF_DIR)/scripts/preprod_stripe_listen.py start
```

- [x] **Step 4: Wire `preprod-deploy`** — right after its `@test -n "$(S)" …` usage line:

```make
	$(PY) $(PP_TF_DIR)/scripts/preprod_integrations.py --no-prompt
```

- [x] **Step 5: Wire `preprod-down`** — right after the `env_guard.py --check-other preprod` line add the stop, and add the tfvars file to the final `rm -rf` list:

```make
	@$(PY) $(PP_TF_DIR)/scripts/preprod_stripe_listen.py stop
```

(`… $(PP_TF_DIR)/image-tags.auto.tfvars.json $(PP_TF_DIR)/integrations.auto.tfvars.json`)

- [x] **Step 6: Dry-run every touched target**

Run: `make -n preprod-up preprod-deploy S=web preprod-down preprod-integrations preprod-stripe-listen STRIPE=off >/dev/null && make -n preprod-integrations STRIPE=off GEOAPIFY=off | grep -- '--stripe-off --geoapify-off' && make lint-comments`
Expected: exit 0, the flags line printed, "no new violations".

- [x] **Step 7: Commit** (main session, confirmation menu) — `feat(infra): wire the pre-prod integrations into make`

---

### Task 10: Documentation and agent rule

**Files:**
- Modify: `.env.example` (append a block)
- Modify: `.claude/skills/local-env-lifecycle/SKILL.md`, then mirror to `.ai/skills/local-env-lifecycle/SKILL.md`
- Vault (via `obsidian-vault` only): runbook `preprod`, `ADR-0022-preprod-ecs-on-floci`, `env-files`, `stripe-sandbox-setup`, `2026-10-02-floci-preprod-environment-design`, `2026-10-05-preprod-integrations-design`, `docs/plans/index.md`

- [x] **Step 1: Append to `.env.example`** (end of file):

```
# ─── .env.preprod ─────────────────────────────────────────────────────────────
# CONTRACT: Pre-prod only, read by make preprod-up / preprod-deploy — never by dev.
# Each *_ENABLED is true | false; empty stops make preprod-up and names the file to fill.
# Test keys only — any *_live_ key is refused. AUTO box (webhook secret + URL tokens)
# is minted by make preprod-up. STRIPE_CLI_API_KEY empty = your `stripe login` session,
# which must be the same sandbox as the keys. See docs/infrastructure/runbooks/preprod.md
# STRIPE_ENABLED=
# STRIPE_SECRET_KEY_USERS=
# STRIPE_SECRET_KEY_ORDERS=
# STRIPE_PUBLISHABLE_KEY=
# STRIPE_CLI_API_KEY=
# GEOAPIFY_ENABLED=
# GEOAPIFY_API_KEY=
```

Run: `.venv/bin/python infra/environments/local/scripts/generate_env_files.py --help >/dev/null; make -n env-file >/dev/null` — expected exit 0 (the example checker only requires dev keys to be present; an extra block is fine).

- [x] **Step 2: Add the agent rule to the skill** — in `.claude/skills/local-env-lifecycle/SKILL.md`, section "Pre-prod — the second local environment": add two rows to its table:

```
| Decide Stripe/Geoapify (prompts with a TTY; `STRIPE=off GEOAPIFY=off` declines) | `make preprod-integrations` |
| Restart the two Stripe webhook forwarders (after a reboot or `preprod-heal`) | `make preprod-stripe-listen` |
```

and this paragraph right after the table:

```
**Before `make preprod-up`, an agent asks the user — Stripe yes/no, Geoapify yes/no — with a
menu.** "No" → pass `STRIPE=off` / `GEOAPIFY=off`. "Yes" → tell the user to fill the CUSTOM box
of `.env.preprod` (run `make preprod-integrations` once without a TTY to create the skeleton),
wait for confirmation, then run `make preprod-up`. Stripe on also needs `stripe login` against the
keys' sandbox (or `STRIPE_CLI_API_KEY`). **Never read, print or write a key value**;
trust only the script's `Stripe: on · Geoapify: off` line. A key pasted in chat lands in the
transcript, and the `!` prefix has no TTY for hidden input.
```

Then: `rsync -a --delete .claude/skills/local-env-lifecycle/ .ai/skills/local-env-lifecycle/ && nvm use && make ai-sync-check` (the check reports "stale" until committed — that is expected).

- [x] **Step 3: Dispatch `obsidian-vault`** (English, no git) with this brief:
  - `docs/infrastructure/runbooks/preprod.md`: new "Integrations" section — `.env.preprod` (CUSTOM keys, AUTO keys), the decision table (copy from the spec §3), `STRIPE=off GEOAPIFY=off`, the agent rule (verbatim from Step 2), later changes (spec §7), the listeners (`make preprod-stripe-listen`, logs under `logs/preprod-stripe/`, doctor line), the E2E note that the 25 `paymentMethodId required` fixture failures known from dev appear with Stripe on (separate follow-up, not a regression). Add `make preprod-integrations` and `make preprod-stripe-listen` to its command table.
  - `ADR-0022-preprod-ecs-on-floci`: dated (2026-10-05) amendment — Stripe and Geoapify go from always-off to a user decision in `.env.preprod`; link the spec.
  - `env-files`: add `.env.preprod` (pre-prod only, AUTO/CUSTOM, mode 600, written by `preprod_integrations.py`, not by `make env-file`).
  - `stripe-sandbox-setup`: "Pre-prod" section — two restricted keys per service; the forwarders started by `make preprod-up` to `:9101`/`:9102` run under the developer's `stripe login` session (same sandbox as the keys, or webhooks never arrive; re-login when it expires), `STRIPE_CLI_API_KEY` only for a machine without a login; one identity ⇒ one signing secret.
  - `2026-10-02-floci-preprod-environment-design`: dated amendment to its Stripe-off decision pointing at the new spec.
  - `2026-10-05-preprod-integrations-design`: record Task 1's outcome (login confirmed against the keys' sandbox) and set `status: accepted` (with its `status/` tag).
  - `docs/plans/index.md`: link this plan.
  - Run the validator and report.

- [x] **Step 4: Commit** (main session, confirmation menu) — `docs(infra): document the pre-prod integrations and the agent rule`

---

### Task 11: Live verification, record, audit, PR

Dev must be DOWN (`make clean-state` if it runs; it refuses while pre-prod runs). Long targets run in the background with a bounded wait (see `docs/lessons/2026-09-22-bound-every-long-running-make-target.md`).

- [x] **Step 1: Regression with both off**

Run: `make preprod-up STRIPE=off GEOAPIFY=off < /dev/null`
Expected: ends with `Stripe: off · Geoapify: off` early in the output, `Stripe is off in .env.preprod — no webhook forwarders started` at the end, smoke 200s. Then `make preprod-e2e ARGS="--project=gateway --project=gateway-tracking --project=email"` → the known baseline: 95 passed, 11 skipped, 0 failed.

- [x] **Step 2: No TTY, undecided → abort + skeleton**

Run: `make preprod-down < /dev/null && mv .env.preprod .env.preprod.bak && make preprod-up < /dev/null; echo EXIT=$?`
Expected: `NO: undecided in .env.preprod: STRIPE_ENABLED, GEOAPIFY_ENABLED`, EXIT non-zero, `.env.preprod` recreated with mode `-rw-------`. Then `mv .env.preprod.bak .env.preprod`.

- [x] **Step 3: Stripe + Geoapify on** — apply the agent rule: ask the user (Spanish, `AskUserQuestion`) yes/no for each; on yes, ask them to fill the CUSTOM box (`STRIPE_CLI_API_KEY` stays empty — Task 1 confirmed the login) and confirm. Then `make preprod-down < /dev/null && make preprod-up < /dev/null`.
Expected:
  - `Stripe: on · Geoapify: on`, and at the end two `forwarding → localhost:910x/…/<token>` lines.
  - `terraform -chdir=infra/environments/preprod state list | grep -c 'aws_secretsmanager_secret.this\["users/STRIPE'` → 3 (and 3 for orders).
  - `curl -s -o /dev/null -w '%{http_code}' 'http://localhost:9090/geocode/?text=Tegucigalpa'` → 200 (nginx appends the key and proxies to Geoapify's autocomplete).
  - Browser at `http://localhost:9090`: checkout pays with card `4242 4242 4242 4242`; `grep -E 'payment_intent.succeeded.*\[200\]' logs/preprod-stripe/orders.log` matches; the order shows paid. Saving a card produces a `payment_method.attached … [200]` line in `logs/preprod-stripe/users.log`.
  - `make preprod-e2e ARGS="--project=gateway --project=gateway-tracking --project=email"` runs the Stripe specs; the only new failures are the known `paymentMethodId required` fixture ones.

- [x] **Step 4: Dead listener is detected**

Run: `kill "$(cat logs/preprod-stripe/users.pid)"; make preprod-doctor; echo EXIT=$?; make preprod-stripe-listen && make preprod-doctor`
Expected: first doctor prints `users: stripe listen is not running - make preprod-stripe-listen` and EXIT=2 (make's code for a failed recipe); after the restart, doctor passes.

- [x] **Step 5: Toggle without rebuilding the world** — set `GEOAPIFY_ENABLED=false` in CUSTOM, `make preprod-deploy S=web`; expected: a new `web:<sha>-cfg<hash>` tag is built and pushed (not "already in ECR"), and `curl -s 'http://localhost:9090/geocode/?text=Tegucigalpa'` now answers 503 `geocoding_disabled` (the Task 4 nginx map). *(Drift: this toggle is incomplete; it needs `make preprod-deploy S=web ENV_ONLY=1` and `make preprod-deploy S=web`, because only `ENV_ONLY=1` applies `module.app_config`.)*

- [x] **Step 6: Record** — dispatch `obsidian-vault` to tick this plan's boxes, and in `docs/plans/2026-10-03-floci-preprod-follow-ups.md` tick the "Stripe + Geoapify opt-in" follow-up with the evidence from Steps 1-5 (no key values).

- [x] **Step 7: Gate** — run the `spec-implementation-audit` skill against the spec and this plan (all three directions); fix doc drift through `obsidian-vault`; a real code defect gets its own change.

- [x] **Step 8: Bring the environment back to what the user wants** (ask: leave pre-prod up, or `make preprod-down` + `make bootstrap` for dev). User decided 2026-10-05: keep pre-prod UP with Stripe on and Geoapify on (new key), applied via `S=web ENV_ONLY=1` then `S=web`; `/geocode/` answers 200 and `preprod-doctor` is green.

- [x] **Step 9: PR** (shipped as PR #119, commit `811d4f6f`; #120, `8000e796`, landed on top) (main session, confirmation menu) — PR `feat/preprod-integrations` → `feature/floci-preprod-env`, title `feat(infra): opt-in Stripe and Geoapify for pre-prod`, body with Summary, Test plan (Steps 1-5 results) and `## References` (spec, plan, follow-ups note), ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Never merge without the user.

## Drift from the shipped code

Recorded by the 2026-10-05 spec-implementation audit. The code is the reference.

- Task 2: the test snippet had a stray trailing `"`; fixed in the shipped test.
- Task 4 Step 4: instructed `git stash`; a plan defect, workers never run git writes.
- Task 7: the shipped `is_forwarder` guard (own process group, not the caller's, `ps` command line contains `stripe` and `listen`) goes beyond the plan's code. See [[2026-10-05-preprod-integrations-design]] section 8.
- Task 9: the `preprod-up` CONTRACT comment was reworded for the comment linter.
- Task 10: `.env.example` uses `See [[preprod]]` instead of the plan's wording.
- Task 11 Step 5: the toggle is `S=web ENV_ONLY=1` plus `S=web`, not `S=web` alone.
- Task 11 Steps 8 (environment decision) and 9 (PR) are intentionally left open.

## Related

- [[2026-10-05-preprod-integrations-design]]
- [[2026-10-03-floci-preprod-follow-ups]]
- [[preprod]]
- [[env-files]]
- [[stripe-sandbox-setup]]
- [[ADR-0022-preprod-ecs-on-floci]]
- [[2026-10-02-floci-preprod-environment-design]]
