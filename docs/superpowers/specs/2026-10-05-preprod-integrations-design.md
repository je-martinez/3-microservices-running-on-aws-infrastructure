---
title: "Pre-Prod Integrations — Opt-In Stripe and Geoapify Design"
type: spec
area: infra
status: accepted
created: 2026-10-05
updated: 2026-10-05
tags:
  - type/spec
  - area/infra
  - status/accepted
propagates-to:
  - "[[ADR-0022-preprod-ecs-on-floci]]"
  - "[[preprod]]"
  - "[[env-files]]"
  - "[[stripe-sandbox-setup]]"
  - "[[2026-10-02-floci-preprod-environment-design]]"
related:
  - "[[2026-10-02-floci-preprod-environment-design]]"
  - "[[2026-10-03-floci-preprod-follow-ups]]"
  - "[[2026-10-05-preprod-integrations]]"
  - "[[2026-09-19-stripe-payments-design]]"
  - "[[2026-09-06-address-geocoding-proxy-design]]"
  - "[[ADR-0022-preprod-ecs-on-floci]]"
  - "[[preprod]]"
  - "[[env-files]]"
  - "[[stripe-sandbox-setup]]"
---

# Pre-Prod Integrations — Opt-In Stripe and Geoapify Design

Revised 2026-10-05: the Stripe CLI runs under the developer's `stripe login` session by default.

## Context / goal

Pre-prod (the Floci-only ECS environment in `infra/environments/preprod/`) hardcodes both third-party integrations OFF:

- `STRIPE_ENABLED = "false"` for `users` and `orders` in `infra/environments/preprod/services.tf`.
- `NG_APP_STRIPE_ENABLED` and `NG_APP_GEOCODE_ENABLED` are `"false"` in `_build_args` of `infra/environments/preprod/scripts/build_push.py`.
- `infra/environments/preprod/scripts/e2e_env.py` blanks every Stripe variable (`STRIPE_VARS`).
- `variable "geoapify_api_key"` in `infra/environments/preprod/variables.tf` defaults to the placeholder `"disabled"`.

**Goal:** let the user opt in to a fully functional Stripe flow in pre-prod (card payment at checkout, saved cards, webhooks reconciling state) and to Geoapify address autocomplete, or explicitly decline each one.

**Scope:** pre-prod only. The dev environment is unchanged.

## Decisions

### 1. One owner script and one make target

`infra/environments/preprod/scripts/preprod_integrations.py`, exposed as `make preprod-integrations`.

- `preprod-up` calls it with `--regenerate`, after the exclusivity guard and before the first apply. It is the only caller that regenerates the AUTO values.
- `preprod-deploy` calls it with `--no-prompt`: it never prompts and **preserves** the existing AUTO values. `--no-prompt` is the only validate-only mode.
- A plain `make preprod-integrations` (no `--regenerate`, no `--no-prompt`) never regenerates the AUTO values, but it prompts for undecided integrations when a TTY is present, rewrites `.env.preprod` and the tfvars file, and preserves the AUTO values.

### 2. The `.env.preprod` file

A file at the repo root, git-ignored by the existing `.env.*` rule and written with mode 600. It follows [[env-files]]: an AUTO-GENERATED box rewritten on every run and a CUSTOM box preserved across runs.

CUSTOM box (user inputs):

```
STRIPE_ENABLED=              # true | false — empty = not decided yet
STRIPE_SECRET_KEY_USERS=     # rk_test_… (policy: PaymentIntents None)
STRIPE_SECRET_KEY_ORDERS=    # rk_test_… (policy: PaymentIntents Write)
STRIPE_PUBLISHABLE_KEY=      # pk_test_…
STRIPE_CLI_API_KEY=          # OPTIONAL — only for a machine without a `stripe login` session
GEOAPIFY_ENABLED=            # true | false
GEOAPIFY_API_KEY=
```

`STRIPE_CLI_API_KEY` is optional and exists only for a machine without a `stripe login` session. Empty means the Stripe CLI uses the developer's login session, which must belong to the **same Stripe sandbox** as the keys above. It is used only by the listeners and `--print-secret` and is never deployed to a service.

Two secret keys because dev already uses distinct restricted keys per service with different policies (see the `ORDERS_STRIPE_SECRET_KEY` renaming CONTRACT in `e2e/playwright.config.ts`, and [[stripe-sandbox-setup]]). The same `sk_test_…` in both is allowed.

AUTO box (derived values). Only `preprod-up` (`--regenerate`) rewrites them, which is safe because `preprod-up` always starts from scratch. `--no-prompt` mode (`preprod-deploy`) and a plain `make preprod-integrations` while pre-prod is up **must preserve** the existing AUTO values: regenerating them on a live environment would desync `integrations.auto.tfvars.json` from the deployed secrets and leave the running `stripe listen` processes forwarding with stale tokens.

- `STRIPE_WEBHOOK_SECRET`, from `stripe listen --print-secret`, run under the same CLI identity as the listeners (the `stripe login` session, or `STRIPE_CLI_API_KEY` when set; no `--api-key`); never printed.
- `STRIPE_WEBHOOK_URL_TOKEN_USERS` and `STRIPE_WEBHOOK_URL_TOKEN_ORDERS`: one random token per service.

With Stripe on and the AUTO values missing, `preprod-deploy` (`--no-prompt`) and a plain `make preprod-integrations` abort with "not generated yet — run `make preprod-up`" (`current_auto` in `preprod_integrations.py`); the remedy is `make preprod-down && make preprod-up`.

### 3. Decision table of the script

| Situation | Behaviour |
|---|---|
| Everything decided and valid | Continue silently; print a summary such as `Stripe: on · Geoapify: off`, never values. |
| Something undecided, TTY present | Prompt `Enable Stripe in pre-prod? [y/n]`; secret keys via `getpass`, publishable key via `input`. Same for Geoapify. Write CUSTOM. |
| Something undecided, no TTY | Create the skeleton file if missing and **abort (exit 1; `make` reports exit 2)** naming the file and the CUSTOM box to fill, or the alternative `STRIPE=off GEOAPIFY=off`. |
| `STRIPE=off` / `GEOAPIFY=off` on the make command line | Write `…_ENABLED=false` without asking. |
| `…_ENABLED=true` with a missing key | Abort naming the missing key. |
| Live keys (`sk_live_`, `rk_live_`, `pk_live_`) | Refused: pre-prod accepts test keys only. |
| Stripe enabled, `stripe` CLI not installed | Abort **before** the apply with install instructions. |

### 4. Agent behaviour

The rule goes into the `local-env-lifecycle` skill and the [[preprod]] runbook. Before `make preprod-up`, the agent asks the user yes/no per integration with a menu:

- **No** → the agent runs `make preprod-up STRIPE=off` and/or `GEOAPIFY=off` accordingly.
- **Yes** → the agent tells the user to fill the CUSTOM box of `.env.preprod` (creating the skeleton first through the no-TTY path if the file is missing) and waits for confirmation.

The agent **never reads or writes key values** and trusts only the script's on/off summary. Rationale: keys pasted in chat land in the transcript, and the `!` prefix gives no interactive TTY for hidden input.

### 5. Terraform wiring

The script writes `infra/environments/preprod/integrations.auto.tfvars.json` (mode 600), added to `infra/environments/preprod/.gitignore` beside `image-tags.auto.tfvars.json`. Keys therefore never appear on a command line or in the Makefile.

New variables:

- Non-sensitive bools `stripe_enabled` and `geoapify_enabled`. They are non-sensitive because they decide which entries exist, and `for_each` keys cannot be sensitive (`infra/modules/app-config/main.tf` uses `nonsensitive(toset(keys(...)))`).
- Sensitive strings `stripe_secret_key_users`, `stripe_secret_key_orders`, `stripe_webhook_secret`, `stripe_webhook_url_token_users`, `stripe_webhook_url_token_orders`.
- The plain variable `stripe_webhook_allowed_cidrs` (empty when Stripe is off). It is not a hardcoded local: the script writes it from dev's `STRIPE_WEBHOOK_ALLOWED_CIDRS` (`generate_env_files.py`) via `stripe_webhook_cidrs()`.
- The existing `geoapify_api_key`.

In `services.tf`:

- Parameters: `STRIPE_ENABLED = tostring(var.stripe_enabled)` for users and orders. Only when enabled, also `STRIPE_WEBHOOK_ALLOWED_CIDRS` (Stripe IPs plus private ranges), which `services.tf` takes from the `stripe_webhook_allowed_cidrs` variable through `local.stripe_parameters` (the list is dev's, the same `STRIPE_WEBHOOK_IPS` + `LOCAL_SOURCE_CIDRS` value in `infra/environments/local/scripts/generate_env_files.py`) and `STRIPE_WEBHOOK_TRUSTED_PROXY_HOPS = "0"`.
- Secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_URL_TOKEN` (each service gets its own key and token), merged in **only** when `stripe_enabled`. Secrets Manager rejects empty values, so when off the entries do not exist, as today.
- Web: `GEOAPIFY_API_KEY` is the real key when enabled and `"disabled"` otherwise.
- Webhook source-IP check: `stripe listen` reaches the ALB from Floci's Docker network, so the private ranges already allow it with hops `0`.

### 6. Web build and image tag

`_build_args("web")` reads `.env.preprod` and passes `NG_APP_STRIPE_ENABLED`, `NG_APP_STRIPE_PUBLISHABLE_KEY` and `NG_APP_GEOCODE_ENABLED`. The secret keys and the Geoapify key are **never** build args.

Web's tag becomes `<base tag>-cfg<hash8>`, where `hash8` is the sha256 of its sorted build args. Reason: a clean tree tags by SHA only (`image_tag` in `build_push.py`) and a tag already in ECR is reused, never rebuilt. Without the suffix, toggling Stripe or changing the publishable key would silently ship the old bundle. Same commit plus same config gives the same tag, so the reuse contract holds. The other services keep their tag format.

### 7. Later changes

- Change a Stripe secret-key value (Stripe staying on): `make preprod-deploy S=users ENV_ONLY=1` and `make preprod-deploy S=orders ENV_ONLY=1`. Safe: the secret entries are unchanged.
- Toggle Geoapify or change the publishable key: `make preprod-deploy S=web ENV_ONLY=1` **and** `make preprod-deploy S=web`. `ENV_ONLY=1` applies `module.app_config`, which holds `web/GEOAPIFY_API_KEY`; the plain deploy rebuilds under the new `-cfg<hash8>` tag, but its `-target module.service["web"]` pulls in only what the task definition references (the SSM parameters and the secret containers), never the secret versions, so the new `web/GEOAPIFY_API_KEY` value is not written. Verified live: with only `S=web`, `/geocode/` stayed 200; after `ENV_ONLY=1` it answered 503 `geocoding_disabled`. Decision: two commands, the Makefile unchanged.
- **Any Stripe toggle, on or off:** `make preprod-down && make preprod-up`. Off to on: the AUTO values only exist after `--regenerate`. On to off: `ENV_ONLY=1` applies only `module.app_config`, which destroys the `STRIPE_*` secrets and SSM parameters while the untargeted task definitions (`module.service`) still reference their ARNs through `module.app_config.refs`; `forceNewDeployment` then starts tasks that cannot resolve them.

### 8. Webhook listeners

New `infra/environments/preprod/scripts/preprod_stripe_listen.py` with `start|stop|status`, modelled on `scripts/watch_services.py` (a pid file and a log per process under `logs/preprod-stripe/`, rotate on start, `start_new_session`, stop the process group).

One process per service because `--forward-to` takes a single URL:

- users → `http://localhost:9101/v1/users/stripe/webhook/<token>`
- orders → `http://localhost:9102/v1/orders/stripe/webhook/<token>`

The event lists come from the `FORWARDS` map in `infra/environments/local/scripts/set_stripe_webhook_secret.py` (single source) and the URL path shape follows `forward_command` there. The ports differ: that map carries dev's container ports (3000/3001), while pre-prod forwards to the ALB listeners 9101/9102 declared in `services.tf`.

- Both forwarders and `--print-secret` run under ONE CLI identity: the developer's `stripe login` session by default, or `STRIPE_CLI_API_KEY` when set, passed in the `STRIPE_API_KEY` environment variable and never as `--api-key` (argv is visible in `ps`). One identity means both processes share the signing secret Terraform deploys. See [Risks](#risks).
- Tokens are never printed; messages show `<token>`.
- `stop` and `running` signal a pid only after `is_forwarder` verifies it: the process leads its own process group, that group is not the caller's, and its `ps` command line contains `stripe` and `listen`. Otherwise only the stale pid file is removed. A stale pid after a crash or reboot could otherwise `killpg` an unrelated group or the caller's own. Covered by `test_preprod_stripe_listen.py`.
- File permissions: `logs/preprod-stripe/` is created `0o700` and its log and pid files `0o600`, because the Stripe CLI writes the `whsec_` signing secret and the URL tokens into those logs. A pre-existing `.env.preprod` is `chmod`ed to `0o600` before any write. The repo `.dockerignore` excludes `logs` and `**/*.auto.tfvars.json`, so neither reaches a build context.
- `preprod-up` runs `start` at the end, only when Stripe is enabled.
- `preprod-down` runs `stop` right after the dev-exclusivity guard, always.
- `preprod-doctor` gains a line checking both listeners are alive when Stripe is on.
- A new idempotent `make preprod-stripe-listen` restarts them after a reboot or `preprod-heal`.

A dead listener leaves pre-prod up but with undelivered webhooks; the doctor reports it.

### 9. E2E

`e2e_env.py` reads `.env.preprod`.

- **Stripe on:** sets `STRIPE_SECRET_KEY` (users key), `ORDERS_STRIPE_SECRET_KEY` (orders key), `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_URL_TOKEN` (users token) and `ORDERS_STRIPE_WEBHOOK_URL_TOKEN` (orders token). Pre-set values win over the dotenv loading in `playwright.config.ts`.
- **Stripe off:** blanks them as today; the existing "blank, never omit" CONTRACT stays true.

With Stripe on, the roughly 25 `paymentMethodId required` fixture failures known from dev will also appear (23 observed in pre-prod, 2026-10-05). Fixing them is an existing separate follow-up (see [[2026-10-03-floci-preprod-follow-ups]]) and is out of scope here; the runbook must say so.

## Risks

- **Login session on a different sandbox than the keys.** Payments succeed but webhooks silently never arrive. Mitigation: a one-time user check (plan Task 1: `stripe config --list | grep -E '^(display_name|account_id)'`, compared with the Dashboard) and a note in the [[preprod]] runbook.
- **The login session expires periodically** (Stripe documents about 90 days). `--print-secret` then fails during `make preprod-up` with a message asking for `stripe login` (or `STRIPE_CLI_API_KEY`).

- **A revoked or expired `stripe login`** makes the listeners die with 403 "Permission denied" at authentication; `preprod-doctor` catches it. Fix: `stripe logout && stripe login`; a device-flow login started through Claude Code's `!` needs `stripe login --complete-device`. The re-login returned the same signing secret (verified: `--print-secret` equals the deployed `STRIPE_WEBHOOK_SECRET`), so no redeploy is needed.

The former restricted-key risks are resolved: restricted keys never drive the CLI any more.

## Out of scope

- The dev environment.
- The E2E fixtures' missing `paymentMethodId`.
- The web Playwright drift (stale `/^add$/i` selector, `dev-fill`).
- Live keys.

## Testing

**Unit** (pytest in `infra/environments/preprod/scripts/tests/`):

- `test_preprod_integrations.py`: the whole decision table; CUSTOM preserved and AUTO rewritten; tfvars written with mode 600; no output (stdout/stderr captured) contains a key value.
- `test_build_push.py`: the web `-cfg<hash8>` tag changes with the args and is stable for equal args; `_build_args("web")` never includes secret or Geoapify keys.
- `test_e2e_env.py`: Stripe on and off.
- `test_preprod_stripe_listen.py`: command per service, `<token>` masking and the `is_forwarder` guard.
- `test_preprod_doctor.py`: the listener check.

**Terraform:** `validate`, plus a plan with Stripe on and off confirming the Stripe secrets exist only when on.

**Live verification** (recorded in [[2026-10-03-floci-preprod-follow-ups]]):

1. `make preprod-up STRIPE=off GEOAPIFY=off` regression: smoke and E2E as today (95 passed, 11 skipped; see Outcome).
2. No TTY and no file: abort plus skeleton.
3. With test keys: checkout pays with 4242…; the listener log shows `payment_intent.succeeded` delivered 200 and the order marked paid; saving a card reaches Users by webhook; `/geocode/` returns 200; `make preprod-e2e` runs the Stripe specs (minus the known 25).
4. `preprod-doctor` detects a dead listener.

## Outcome / verification

Task 1: `stripe login` was confirmed against the 3MRAI sandbox on 2026-10-05; `STRIPE_CLI_API_KEY` stays empty. Live evidence (2026-10-05, no key values):

- Both off: `make preprod-up STRIPE=off GEOAPIFY=off` took 3m34s, exit 0, printed "Stripe: off · Geoapify: off" and "no webhook forwarders started"; smoke 200s; E2E (gateway, gateway-tracking, email) 95 passed, 11 skipped, 0 failed (the baseline).
- No TTY, no file: "NO: undecided in .env.preprod: STRIPE_ENABLED, GEOAPIFY_ENABLED", make exit 2, skeleton created `-rw-------`, no tfvars written.
- Both on: `make preprod-up` took 3m40s, exit 0, "Stripe: on · Geoapify: on", two forwarding lines, both listeners "Ready!", 3 `users/STRIPE*` and 3 `orders/STRIPE*` secrets, `/geocode/` 200, smoke 200s.
- E2E with Stripe on: 82 passed, 23 failed, 1 skipped; all 23 are order creation 400 "paymentMethodId field is required" (the known fixture follow-up).
- Browser: order 261005-CWZX74 paid with 4242; `orders.log` shows `payment_intent.succeeded` [200]; `users.log` shows `payment_method.attached` [200].
- Dead listener: after killing the users listener, `preprod-doctor` reported "NO: users: stripe listen is not running - make preprod-stripe-listen", exit 2. The restart hit 403 (login revoked mid-session); `stripe logout && stripe login`, `--print-secret` equal to the deployed secret, `make preprod-stripe-listen` both "Ready!", doctor exit 0.
- Geoapify toggle: `GEOAPIFY_ENABLED=false` plus `make preprod-deploy S=web` built and pushed a new `web:<sha>-cfgc5d25e09` (not "already in ECR") and `/geocode/` stayed 200; adding `make preprod-deploy S=web ENV_ONLY=1` gave 503 `geocoding_disabled`.

## Documentation propagation

- [[ADR-0022-preprod-ecs-on-floci]]: dated amendment (integrations go from always-off to a user decision).
- [[preprod]] runbook: "Integrations" section (file, flow, later changes, agent rule, the known 25 failures).
- [[env-files]]: gains `.env.preprod`; `.env.example` gains its block as the committed contract.
- [[stripe-sandbox-setup]]: gains a pre-prod section (listeners, two restricted keys).
- `local-env-lifecycle` skill (`.claude/` and `.ai/`): gains the agent rule.
- [[2026-10-02-floci-preprod-environment-design]]: dated amendment to its Stripe-off decision.

## Branch

`feat/preprod-integrations` off `feature/floci-preprod-env`, PR into `feature/floci-preprod-env`, so it ships inside the pre-prod milestone PR to `main`.

## Related

- [[2026-10-02-floci-preprod-environment-design]]
- [[2026-10-03-floci-preprod-follow-ups]]
- [[2026-10-05-preprod-integrations]]
- [[2026-09-19-stripe-payments-design]]
- [[2026-09-06-address-geocoding-proxy-design]]
- [[ADR-0022-preprod-ecs-on-floci]]
- [[preprod]]
- [[env-files]]
- [[stripe-sandbox-setup]]
