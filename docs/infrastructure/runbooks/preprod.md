---
title: Pre-production — Floci environment
type: runbook
area: infra
status: active
created: 2026-10-03
updated: 2026-10-05
integration-status: verified
verified-on: 2026-10-03
verified-by: Jose E. Martinez
tags:
  - type/runbook
  - area/infra
  - status/active
related:
  - "[[2026-10-02-floci-preprod-environment-design]]"
  - "[[2026-10-02-floci-preprod-environment]]"
  - "[[2026-10-05-preprod-integrations-design]]"
  - "[[2026-10-05-preprod-integrations]]"
  - "[[ADR-0022-preprod-ecs-on-floci]]"
  - "[[environment-exclusivity]]"
  - "[[2026-10-03-floci-preprod-alb-and-ecs-behaviours]]"
  - "[[local-dev-floci]]"
  - "[[terraform-modules]]"
  - "[[stripe-sandbox-setup]]"
  - "[[2026-10-03-floci-preprod-follow-ups]]"
  - "[[testing]]"
---

# Pre-production — Floci environment

A disposable environment whose only compose image is Floci 2.1.0. `users`, `orders`, `tracking`,
`web`, `otel-collector`, `openobserve` and `mailpit` run as ECS services pulled from Floci's ECR,
configured from SSM and Secrets Manager, behind API Gateway and per-service ALB listeners (no
nginx). Decision: [[ADR-0022-preprod-ecs-on-floci]]. It cannot run beside dev
([[environment-exclusivity]]).

## Start from scratch

```bash
make preprod-up        # about 3m40s from scratch
```

Order: exclusivity guard (`env_guard.py preprod`), Floci up (compose project `3mrai-preprod`, healthcheck
`GET /_floci/health HTTP/1.1`; the guard and Floci are the `preprod-floci-up` prerequisite),
live-environment check (`preprod_live.py`), `lambda-bundles`, `terraform init`, Terraform apply with `deploy_services=false` (data stores,
Cognito, messaging, ECR, config), build and push every image, `preprod-migrate`, apply with
`deploy_services=true` (ECS services, ALB, gateway), wait for RUNNING tasks, deregister stale ALB
targets, aliases, smoke, then `preprod-observability` (seed + dashboards). It does not run
`preprod-doctor`. It is **not resumable**: on failure run
`make preprod-down && make preprod-up`.

`make preprod-up` refuses when pre-prod is already up: its first apply (`deploy_services=false`)
would destroy and rebuild every service. `preprod_live.py` runs after the guard and Floci start and before
that apply, and fails when the
ECS cluster in local state has any service. Use `make preprod-deploy S=<svc>` or `make preprod-down` first.

## Make targets

| Target | Does |
|---|---|
| `preprod-up` | Everything, from scratch; refuses on a live environment. Decides the integrations first (`preprod_integrations.py --regenerate`) and, when Stripe is on, starts the webhook forwarders last. `STRIPE=off GEOAPIFY=off` declines without asking |
| `preprod-integrations` | Decide Stripe and Geoapify in `.env.preprod` (prompts with a TTY; `STRIPE=off GEOAPIFY=off` declines). It never regenerates the AUTO values, but it may prompt (with a TTY) and rewrites `.env.preprod` and the tfvars file; with Stripe on and no AUTO values it stops with "run `make preprod-up`" |
| `preprod-stripe-listen` | (Re)start the two `stripe listen` webhook forwarders; idempotent. Use after a reboot or `preprod-heal` |
| `preprod-deploy S=<svc>` | Build, push with a new immutable tag, `-target` apply for that service, wait, clean stale targets, aliases, smoke. `ENV_ONLY=1` skips the build, applies `module.app_config` (writes the edited SSM and Secrets Manager values from `services.tf`), then forces a new deployment (ECS reads SSM and secrets only at task start) |
| `preprod-heal` | After a Floci or Docker restart: Floci up, start Exited DocumentDB/Valkey containers, remove orphan task containers, wait, clean stale targets, re-apply aliases |
| `preprod-doctor` | ECS services vs containers, ALB target health, stale ALB targets (`preprod_targets.py --check`), aliases (`preprod_aliases.py --check`), phantom DocumentDB/Valkey, and (Stripe on) both webhook forwarders; prints the remedy per failure (heal vs down + up) |
| `preprod-smoke` | `/v1/health` on 9101-9103, `:9090/`, `:5080/healthz` |
| `preprod-aliases` | Attach `users-grpc` and `mailpit` Docker aliases to the newest RUNNING task |
| `preprod-migrate` | Prisma (users) and golang-migrate (tracking) against Floci's RDS |
| `preprod-observability` | Seed the OpenObserve traces schema, import dashboards |
| `preprod-e2e ARGS=…` | Playwright against pre-prod (`ARGS="--project=gateway"`) |
| `preprod-load-test` / `preprod-load-test-smoke` | Gatling `fullJourney` / a ~20 s run |
| `preprod-down` | Stops the Stripe forwarders first, then a full wipe: `down -v`, Floci children, ECR registry and volume, Floci volumes, local TF state, `integrations.auto.tfvars.json` and the `.terraform*` directories; refuses while the dev stack runs |

## Ports

| Host port | Reaches |
|---|---|
| `4566` | Floci AWS APIs and ECR |
| `9101` / `9102` / `9103` | ALB → users / orders / tracking (E2E internal layer) |
| `9090` | ALB → web (nginx serves the bundle; `/v1` → API Gateway) |
| `5080` | ALB → OpenObserve UI and ingest |
| `8025` | ALB → Mailpit UI and API |

Internal only: OTLP `4318` (collector, traces; logs travel `awslogs` → CloudWatch → collector, and
Users and Tracking set `OTEL_LOGS_EXPORTER=none`; Orders sets it in neither pre-prod nor dev, so pre-prod
matches dev) and `4319` (browser RUM). The API Gateway
URL comes from `terraform output` in `infra/environments/preprod`.

## Configuration layout

- Parameters: SSM `/3mrai-preprod/<svc>/<VAR>`. Secrets: Secrets Manager `3mrai-preprod/<svc>/<VAR>`.
- Task definitions reference both by ARN in `secrets`; nothing is declared inline.
- **Pre-prod has no `.env.local.*` files** ([[env-files]]); its one env file is `.env.preprod` (see Integrations).
- A config change takes effect with `make preprod-deploy S=<svc> ENV_ONLY=1`: edit the value in
  `services.tf`; the target writes it to SSM or Secrets Manager, then starts new tasks. A toggled
  integration also needs a web rebuild: both `S=web ENV_ONLY=1` and `S=web` (see Later changes).
- Collector endpoint: `O2_ENDPOINT`. Web RUM upstream: `OTLP_RUM_UPSTREAM`.
- Image tags: `<sha12>` or `<sha12>-dirty-<epoch>-<hash8>` in
  `infra/environments/preprod/image-tags.auto.tfvars.json`.
- `build_push.py` skips build and push for a service whose tag already exists in ECR (tags are
  immutable), so the same commit with a clean tree reuses the pushed image and only records the tag.

## Heal and doctor

After `docker compose restart`, a Docker daemon restart or a Floci recreate, run
`make preprod-heal`, then `make preprod-doctor` (all green expected). Heal and `preprod_targets.py` treat a
task as dead only when its `lastStatus` is STOPPED. Floci stops with SIGKILL
so DocumentDB and ElastiCache keep their data; OpenObserve and Mailpit have no volume, so their
data resets. Re-run `make preprod-observability` after OpenObserve is recreated.

## Redeploy one service

```bash
make preprod-deploy S=users          # code change
make preprod-deploy S=users ENV_ONLY=1   # config change
```

A toggled integration needs both `make preprod-deploy S=web ENV_ONLY=1` and `make preprod-deploy S=web`
(see Later changes).

`ENV_ONLY=1` also re-creates the DB-URL secret versions with identical values (Floci RDS drift
makes Terraform see a change); this is harmless and brief.

Expect about 1-2 s of `503` on that service during the rollout (Floci limit, not a regression).
All images must already be pushed before any deploy (the `-target` apply still evaluates every
image tag).

## Integrations (Stripe and Geoapify)

Both third-party integrations are a **user decision**, not hardcoded off
([[2026-10-05-preprod-integrations-design]], amending [[ADR-0022-preprod-ecs-on-floci]]). Pre-prod
only; dev is unchanged. Owner script: `infra/environments/preprod/scripts/preprod_integrations.py`.

### `.env.preprod`

A git-ignored file at the repo root, mode 600, with the AUTO and CUSTOM boxes of [[env-files]]
(written by `preprod_integrations.py`, not by `make env-file`).

- **CUSTOM box (you fill it):** `STRIPE_ENABLED`, `STRIPE_SECRET_KEY_USERS`,
  `STRIPE_SECRET_KEY_ORDERS`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_CLI_API_KEY` (optional),
  `GEOAPIFY_ENABLED`, `GEOAPIFY_API_KEY`. Each `*_ENABLED` is `true` or `false`; empty means
  undecided and stops `make preprod-up`. Test keys only: any `*_live_` key is refused.
- **AUTO box (minted by `make preprod-up`):** `STRIPE_WEBHOOK_SECRET` (from
  `stripe listen --print-secret`) and one `STRIPE_WEBHOOK_URL_TOKEN` per service. Only
  `preprod-up` regenerates them.
- The script also writes `infra/environments/preprod/integrations.auto.tfvars.json` (mode 600,
  git-ignored), so no key appears on a command line or in the Makefile. A key value is never
  printed; the script prints only `Stripe: on · Geoapify: off`.
- `STRIPE_CLI_API_KEY` empty means the Stripe CLI uses your `stripe login` session, which must
  belong to the **same sandbox** as the keys. See [[stripe-sandbox-setup]].

### Decision table

| Situation | Behaviour |
|---|---|
| Everything decided and valid | Continue silently; print a summary such as `Stripe: on · Geoapify: off`, never values |
| Something undecided, TTY present | Prompt `Enable Stripe? [y/n]`; secret keys hidden (`getpass`), publishable key via `input`; same for Geoapify; writes CUSTOM |
| Something undecided, no TTY | Create the skeleton file if missing and abort (exit 1), naming the file and the CUSTOM box to fill, or the alternative `STRIPE=off GEOAPIFY=off` |
| `STRIPE=off` / `GEOAPIFY=off` on the make command line | Write `..._ENABLED=false` without asking |
| `..._ENABLED=true` with a missing key | Abort naming the missing key |
| Live keys (`sk_live_`, `rk_live_`, `pk_live_`) | Refused: pre-prod accepts test keys only |
| Stripe enabled, `stripe` CLI not installed | Abort before the apply with install instructions |

### Agent rule

**Before `make preprod-up`, an agent asks the user — Stripe yes/no, Geoapify yes/no — with a
menu.** "No" → pass `STRIPE=off` / `GEOAPIFY=off`. "Yes" → tell the user to fill the CUSTOM box
of `.env.preprod` (run `make preprod-integrations` once without a TTY to create the skeleton),
wait for confirmation, then run `make preprod-up`. Stripe on also needs `stripe login` against the
keys' sandbox (or `STRIPE_CLI_API_KEY`). **Never read, print or write a key value**;
trust only the script's `Stripe: on · Geoapify: off` line. A key pasted in chat lands in the
transcript, and the `!` prefix has no TTY for hidden input.

The same rule lives in the `local-env-lifecycle` skill.

### Later changes

`preprod-deploy` runs the script with `--no-prompt` (it never prompts and preserves the AUTO
values).

- Change a Stripe secret-key value (Stripe staying on): `make preprod-deploy S=users ENV_ONLY=1` and
  `make preprod-deploy S=orders ENV_ONLY=1`. Safe: the secret entries are unchanged.
- Toggle Geoapify or change the publishable key: `make preprod-deploy S=web ENV_ONLY=1` **and**
  `make preprod-deploy S=web`. The web image tag carries a hash of its build args
  (`<base tag>-cfg<hash8>`), so the plain deploy rebuilds instead of reusing the old bundle, but its
  `-target` apply never touches `module.app_config`, which holds `web/GEOAPIFY_API_KEY`;
  `ENV_ONLY=1` applies it. With only `S=web`, `/geocode/` stayed 200 after turning Geoapify off;
  after `ENV_ONLY=1` it answered 503 `geocoding_disabled`.
- **Any Stripe toggle, on or off:** `make preprod-down && make preprod-up`. Off to on, the webhook
  secret and URL tokens exist only after a from-scratch `preprod-up`. On to off, `ENV_ONLY=1`
  applies only `module.app_config`, which destroys the `STRIPE_*` secrets and SSM parameters while
  the untargeted task definitions still reference their ARNs, so the forced new deployment starts
  tasks that cannot resolve them.

### Webhook listeners

`make preprod-up` starts two `stripe listen` processes at the end (only when Stripe is on); one
per service because `--forward-to` takes a single URL: users to
`localhost:9101/v1/users/stripe/webhook/<token>`, orders to
`localhost:9102/v1/orders/stripe/webhook/<token>`. Both run under one CLI identity (your
`stripe login` session, or `STRIPE_CLI_API_KEY` passed in the `STRIPE_API_KEY` environment
variable, never `--api-key`), so they share the signing secret Terraform deployed. Logs and pid
files live under `logs/preprod-stripe/`. `preprod-down` stops them right after the dev-exclusivity guard.

File permissions: `logs/preprod-stripe/` is created `0o700` and its log and pid files `0o600`,
because the Stripe CLI writes the `whsec_` signing secret and the URL tokens into those logs
(local and git-ignored; never paste them). A pre-existing `.env.preprod` is `chmod`ed to `0o600`
before any write, and the repo `.dockerignore` excludes `logs` and `**/*.auto.tfvars.json`, so
neither reaches a build context.

- Restart after a reboot or `preprod-heal`: `make preprod-stripe-listen` (idempotent).
- `make preprod-doctor` fails with the listener line when Stripe is on and either forwarder is
  down. A dead listener leaves pre-prod up with webhooks silently undelivered.
- `preprod_stripe_listen.py stop` signals a pid only when it is still one of our forwarders (its
  command line contains `stripe listen`, it leads its own process group, and it is not the
  caller's group); otherwise it just removes the stale pid file, and `status` reports that
  listener down.
- Listeners dying with 403 "Permission denied" at authentication means the login was revoked or
  expired: `stripe logout && stripe login`, then `make preprod-stripe-listen`. No redeploy is
  needed: the re-login returned the same signing secret (`--print-secret` equals the deployed
  `STRIPE_WEBHOOK_SECRET`). A device-flow login started through Claude Code's `!` needs
  `stripe login --complete-device`.
- Login session on a different sandbox than the keys: payments succeed but webhooks never
  arrive. If the login expires (about 90 days), `make preprod-up` fails at `--print-secret`
  asking for `stripe login`.

### E2E with Stripe on

`e2e_env.py` reads `.env.preprod` and exports the Stripe variables when Stripe is on (blank, never
omitted, when off). With Stripe on, about 25 `paymentMethodId required` fixture failures (23 observed in pre-prod with Stripe on,
2026-10-05), known from dev, also appear in `make preprod-e2e`. That is a separate follow-up
([[2026-10-03-floci-preprod-follow-ups]]), not a regression.

## Teardown

`make preprod-down` removes everything including Floci-created RDS volumes and the ECR registry
container. Anything less leaves `RepositoryAlreadyExists` on the next apply or phantom stores.

It refuses while the dev stack (compose project `3mrai`) runs: its `floci-` container and
`floci=true` volume sweeps would delete dev's Floci children and data. Drop dev first with
`make clean` if that is intended. The mirror guard applies too: `make clean` and `make clean-state`
refuse while pre-prod runs ([[environment-exclusivity]]).

## Verification

- `make preprod-up` ends with smoke and `preprod-observability`; run `make preprod-doctor` afterwards (green expected).
- `make preprod-e2e` (and the load targets) run through `e2e_env.py`, which exports the Terraform
  outputs as env vars, including `WEBHOOK_SECRET` and `EVENTS_QUEUE_URL`.
- `make preprod-e2e ARGS="--project=gateway --project=gateway-tracking --project=email"`:
  95 passed, 11 skipped (Stripe disabled, cache-off spec), 0 failed.
- The observability project passes 6/6. The web build has RUM on (`NG_APP_RUM_ENABLED=true`), so
  the `rum_logs` stream appears once a browser loads the web app on `:9090`.
- `make preprod-load-test-smoke`: 551 requests, 0 failures. Full `preprod-load-test` saturates
  Floci's single process (86% / 59% OK, p95 17-50 s); a local capacity limit.

### Integrations verification (2026-10-05)

No key values recorded.

- Both off: `make preprod-up STRIPE=off GEOAPIFY=off` 3m34s, exit 0, "Stripe: off · Geoapify: off", "no webhook forwarders started", smoke 200s; E2E (gateway, gateway-tracking, email) 95 passed, 11 skipped, 0 failed (baseline).
- No TTY, no file: "NO: undecided in .env.preprod: STRIPE_ENABLED, GEOAPIFY_ENABLED", make exit 2, skeleton created `-rw-------`, no tfvars written.
- Both on: `make preprod-up` 3m40s, exit 0, "Stripe: on · Geoapify: on", two forwarding lines, both listeners "Ready!", 3 `users/STRIPE*` and 3 `orders/STRIPE*` secrets, `/geocode/` 200, smoke 200s.
- E2E with Stripe on: 82 passed, 23 failed, 1 skipped; all 23 are order creation 400 "paymentMethodId field is required" (known fixture follow-up).
- Browser: order 261005-CWZX74 paid with 4242; `orders.log` `payment_intent.succeeded` [200]; `users.log` `payment_method.attached` [200].
- Dead listener: killed users listener, `preprod-doctor` "NO: users: stripe listen is not running - make preprod-stripe-listen", exit 2; the restart hit 403 (login revoked mid-session), `stripe logout && stripe login`, `--print-secret` equal to the deployed secret, `make preprod-stripe-listen` both "Ready!", doctor exit 0.
- Geoapify toggle: `GEOAPIFY_ENABLED=false` plus `make preprod-deploy S=web` built and pushed a new `web:<sha>-cfgc5d25e09` (not "already in ECR"), `/geocode/` still 200; plus `make preprod-deploy S=web ENV_ONLY=1` gave 503 `geocoding_disabled`.

### Verification results

- **SC1** gateway, gateway-tracking and email E2E: 95 passed, 11 skipped, 0 failed.
- **SC2** Gatling smoke: 551 requests, 0 failures. Full load saturates Floci (known limit).
- **SC3** logs and traces of users, orders and tracking are queryable in OpenObserve.
- **SC4** a real browser at `:9090` completes register, login, cart, address and pay;
  `POST /v1/orders` returns `201`. The `web-tokyo` Playwright project: 115 passed, 13 failed,
  6 skipped; the failures are pre-existing selector drift and dev-fill dependencies, not pre-prod.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Gateway `{"message":"Not Found"}` | Route missing in `infra/modules/api-gateway`; the request never reached a service |
| Intermittent `503`, lasting 1-2 minutes after a deploy | Stale ALB target; `make preprod-heal` or deploy again (cleanup runs automatically) |
| Orders' gRPC dial to `users-grpc` fails to resolve (DNS) | `users-grpc` alias missing; `make preprod-aliases`. The ALB is not a gRPC path: it answers gRPC with `502` |
| Welcome email not delivered | `mailpit` alias missing; `make preprod-aliases` |
| `RepositoryAlreadyExists` on apply | ECR registry survived a teardown; `make preprod-down` |
| `NoSuchBucket` pulling an image | Dev Floci owns `:4566`; see [[environment-exclusivity]] |
| OpenObserve crash loop | Root password rejected; keep special characters in the generated password |
| `preprod-deploy` / `preprod-integrations` says the AUTO values are not generated | Stripe is on but `preprod-up` never minted them; `make preprod-down && make preprod-up` |
| Trace waterfall `HTTP 400` | `make observability-traces-schema` equivalent: `make preprod-observability` |

Cause and evidence for each Floci behaviour: [[2026-10-03-floci-preprod-alb-and-ecs-behaviours]].

## Related

- [[2026-10-02-floci-preprod-environment-design]]
- [[2026-10-02-floci-preprod-environment]]
- [[2026-10-05-preprod-integrations-design]]
- [[2026-10-05-preprod-integrations]]
- [[2026-10-03-floci-preprod-follow-ups]]
- [[stripe-sandbox-setup]]
- [[ADR-0022-preprod-ecs-on-floci]]
- [[environment-exclusivity]]
- [[2026-10-03-floci-preprod-alb-and-ecs-behaviours]]
- [[local-dev-floci]]
- [[terraform-modules]]
- [[env-files]]
- [[testing]]
