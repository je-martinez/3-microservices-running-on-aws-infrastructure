---
title: "Pre-Prod Integrations — Opt-In Stripe and Geoapify Design"
type: spec
area: infra
status: draft
created: 2026-10-05
updated: 2026-10-05
tags:
  - type/spec
  - area/infra
  - status/draft
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
- `preprod-deploy` calls it in **validate-only** mode: it never prompts and **preserves** the existing AUTO values.
- A plain `make preprod-integrations` (no `--regenerate`) behaves like validate-only, so it is safe while pre-prod is up.

### 2. The `.env.preprod` file

A file at the repo root, git-ignored by the existing `.env.*` rule and written with mode 600. It follows [[env-files]]: an AUTO-GENERATED box rewritten on every run and a CUSTOM box preserved across runs.

CUSTOM box (user inputs):

```
STRIPE_ENABLED=              # true | false — empty = not decided yet
STRIPE_SECRET_KEY_USERS=     # rk_test_… (policy: PaymentIntents None)
STRIPE_SECRET_KEY_ORDERS=    # rk_test_… (policy: PaymentIntents Write)
STRIPE_PUBLISHABLE_KEY=      # pk_test_…
GEOAPIFY_ENABLED=            # true | false
GEOAPIFY_API_KEY=
```

Conditional fallback (see [Risks](#risks--to-verify-first)): if `stripe listen` refuses restricted keys, the CUSTOM box gains an optional `STRIPE_CLI_API_KEY=` (an `sk_test_…`), used only by the listeners and `--print-secret` and never deployed to a service.

Two secret keys because dev already uses distinct restricted keys per service with different policies (see the `ORDERS_STRIPE_SECRET_KEY` renaming CONTRACT in `e2e/playwright.config.ts`, and [[stripe-sandbox-setup]]). The same `sk_test_…` in both is allowed.

AUTO box (derived values). Only `preprod-up` (`--regenerate`) rewrites them, which is safe because `preprod-up` always starts from scratch. Validate-only mode (`preprod-deploy`) and a plain `make preprod-integrations` while pre-prod is up **must preserve** the existing AUTO values: regenerating them on a live environment would desync `integrations.auto.tfvars.json` from the deployed secrets and leave the running `stripe listen` processes forwarding with stale tokens.

- `STRIPE_WEBHOOK_SECRET`, from `stripe listen --print-secret --api-key <users key>`; never printed.
- One `STRIPE_WEBHOOK_URL_TOKEN` per service (random).

### 3. Decision table of the script

| Situation | Behaviour |
|---|---|
| Everything decided and valid | Continue silently; print a summary such as `Stripe: on · Geoapify: off`, never values. |
| Something undecided, TTY present | Prompt `Enable Stripe? [y/n]`; secret keys via `getpass`, publishable key via `input`. Same for Geoapify. Write CUSTOM. |
| Something undecided, no TTY | Create the skeleton file if missing and **abort (exit 1)** naming the file and the CUSTOM box to fill, or the alternative `STRIPE=off GEOAPIFY=off`. |
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
- The existing `geoapify_api_key`.

In `services.tf`:

- Parameters: `STRIPE_ENABLED = tostring(var.stripe_enabled)` for users and orders. Only when enabled, also `STRIPE_WEBHOOK_ALLOWED_CIDRS` (Stripe IPs plus private ranges, the same list as `STRIPE_WEBHOOK_IPS` + `LOCAL_SOURCE_CIDRS` in `infra/environments/local/scripts/generate_env_files.py`) and `STRIPE_WEBHOOK_TRUSTED_PROXY_HOPS = "0"`.
- Secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_URL_TOKEN` (each service gets its own key and token), merged in **only** when `stripe_enabled`. Secrets Manager rejects empty values, so when off the entries do not exist, as today.
- Web: `GEOAPIFY_API_KEY` is the real key when enabled and `"disabled"` otherwise.
- Webhook source-IP check: `stripe listen` reaches the ALB from Floci's Docker network, so the private ranges already allow it with hops `0`.

### 6. Web build and image tag

`_build_args("web")` reads `.env.preprod` and passes `NG_APP_STRIPE_ENABLED`, `NG_APP_STRIPE_PUBLISHABLE_KEY` and `NG_APP_GEOCODE_ENABLED`. The secret keys and the Geoapify key are **never** build args.

Web's tag becomes `<base tag>-cfg<hash8>`, where `hash8` is the sha256 of its sorted build args. Reason: a clean tree tags by SHA only (`image_tag` in `build_push.py`) and a tag already in ECR is reused, never rebuilt. Without the suffix, toggling Stripe or changing the publishable key would silently ship the old bundle. Same commit plus same config gives the same tag, so the reuse contract holds. The other services keep their tag format.

### 7. Later changes

- Change a Stripe secret key: `make preprod-deploy S=users ENV_ONLY=1` (and `S=orders`).
- Toggle an integration or change the publishable key: `make preprod-deploy S=web` (rebuilds through the new tag); for Stripe also `users` and `orders` with `ENV_ONLY=1`.

### 8. Webhook listeners

New `infra/environments/preprod/scripts/preprod_stripe_listen.py` with `start|stop|status`, modelled on `scripts/watch_services.py` (a pid file and a log per process under `logs/preprod-stripe/`, rotate on start, `start_new_session`, stop the process group).

One process per service because `--forward-to` takes a single URL:

- users → `http://localhost:9101/v1/users/stripe/webhook/<token>`
- orders → `http://localhost:9102/v1/orders/stripe/webhook/<token>`

The event lists come from the `FORWARDS` map in `infra/environments/local/scripts/set_stripe_webhook_secret.py` (single source) and the URL path shape follows `forward_command` there. The ports differ: that map carries dev's container ports (3000/3001), while pre-prod forwards to the ALB listeners 9101/9102 declared in `services.tf`.

- Each listener passes `--api-key` with its own service's key, so there is no dependency on `stripe login`. If restricted keys are refused (see [Risks](#risks--to-verify-first)), every listener uses `STRIPE_CLI_API_KEY` instead.
- Tokens are never printed; messages show `<token>`.
- `preprod-up` runs `start` at the end, only when Stripe is enabled.
- `preprod-down` runs `stop` first, always.
- `preprod-doctor` gains a line checking both listeners are alive when Stripe is on.
- A new idempotent `make preprod-stripe-listen` restarts them after a reboot or `preprod-heal`.

A dead listener leaves pre-prod up but with undelivered webhooks; the doctor reports it.

### 9. E2E

`e2e_env.py` reads `.env.preprod`.

- **Stripe on:** sets `STRIPE_SECRET_KEY` (users key), `ORDERS_STRIPE_SECRET_KEY` (orders key), `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_URL_TOKEN` (users token) and `ORDERS_STRIPE_WEBHOOK_URL_TOKEN` (orders token). Pre-set values win over the dotenv loading in `playwright.config.ts`.
- **Stripe off:** blanks them as today; the existing "blank, never omit" CONTRACT stays true.

With Stripe on, the 25 `paymentMethodId required` fixture failures known from dev will also appear. Fixing them is an existing separate follow-up (see [[2026-10-03-floci-preprod-follow-ups]]) and is out of scope here; the runbook must say so.

## Risks / to verify first

Not yet verified; the implementation plan checks these first:

- `stripe listen` accepts a **restricted** key (`rk_test_…`) for `--api-key` and `--print-secret`.
- The two listeners, each with its own service key, receive the **same** signing secret (dev uses one `whsec_` for both services).

Fallback if restricted keys are refused: an optional `STRIPE_CLI_API_KEY` (an `sk_test_…`) in the CUSTOM box, used only by the listeners and `--print-secret`, never deployed to a service (decisions 2 and 8).

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
- `test_preprod_stripe_listen.py`: command per service and `<token>` masking.

**Terraform:** `validate`, plus a plan with Stripe on and off confirming the Stripe secrets exist only when on.

**Live verification** (recorded in [[2026-10-03-floci-preprod-follow-ups]]):

1. `make preprod-up STRIPE=off GEOAPIFY=off` regression: smoke and E2E as today (95 passed, 11 skipped).
2. No TTY and no file: abort plus skeleton.
3. With test keys: checkout pays with 4242…; the listener log shows `payment_intent.succeeded` delivered 200 and the order marked paid; saving a card reaches Users by webhook; `/geocode/` returns 200; `make preprod-e2e` runs the Stripe specs (minus the known 25).
4. `preprod-doctor` detects a dead listener.

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
