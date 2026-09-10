---
title: Env Files
type: convention
area: infra
status: active
created: 2026-07-20
updated: 2026-09-10
tags:
  - type/convention
  - area/infra
  - status/active
related:
  - "[[2026-07-20-env-file-generation-design]]"
  - "[[scripting-language]]"
  - "[[local-dev]]"
  - "[[testing]]"
  - "[[events-pipeline-design]]"
  - "[[2026-08-03-events-pipeline-milestone-design]]"
  - "[[2026-08-25-response-caching-layer-design]]"
  - "[[x-cache-response-header]]"
  - "[[2026-09-04-web-gateway-integration-design]]"
  - "[[web-gateway-integration-milestone]]"
  - "[[2026-09-06-address-geocoding-proxy-design]]"
  - "[[2026-09-07-a-dead-path-is-not-fail-closed-against-an-external-host]]"
  - "[[2026-07-30-post-infra-root-design]]"
  - "[[2026-07-30-post-infra-root]]"
---

# Env Files

## The rule

Every env file is **generated** by `make env-file` from Terraform outputs. None is
hand-maintained, because the values change on every apply: Floci mints new Cognito ids and a
new API id, and reassigns RDS proxy ports by cluster creation order.

## The files and their consumers

| File | Holds | Consumed by |
|---|---|---|
| `.env` | ONLY the four vars compose interpolates as `${VAR}` | docker-compose interpolation |
| `.env.local.infra` | Terraform outputs (Cognito ids, API GW url, DB hosts/ports) **plus `MAILPIT_API_URL`** | the E2E suite, humans |
| `.env.local.users` | the Users service environment | compose `env_file:` |
| `.env.local.orders` | the Orders service environment | compose `env_file:` |
| `.env.local.tracking` | the Tracking service environment (incl. `E2E_TESTING_ENABLED=true` in CUSTOM, `EVENTS_QUEUE_URL`) | compose `env_file:` |
| `.env.local.events-pipeline` | the events-pipeline Lambda environment (DocumentDB connection, `EVENTS_QUEUE_URL`, SES sender) | the Lambda's environment variables, set via Terraform |
| `.env.local.debug` | HOST-reachable connection strings | a SQL client; **loaded by nothing** |
| `.env.local.web` | the web app's build-time env (`NG_APP_API_GATEWAY_URL`, `NG_APP_STRIPE_ENABLED`, `NG_APP_GEOCODE_ENABLED`) **plus the runtime `GEOAPIFY_API_KEY`** | compose `env_file:` for the `web` service, `@ngx-env/builder`, and `apps/web/nginx.conf`'s envsubst template |
| `.env.example` | the committed contract | documentation only |

`.env.local.web` was added with the [[2026-09-04-web-gateway-integration-design]] milestone
([[web-gateway-integration-milestone]]), generated the same way as every other per-service
file. Alongside it, `make env-file` also generates **`apps/web/proxy.conf.mjs`** — the `ng
serve` development-proxy target, pointing at Floci's gateway from the developer's host. Unlike
the `.env.local.*` files, this one is not a dotenv file; it is a generated **ES module**
consumed via `ng serve --proxy-config`, exporting the same shape Angular's proxy config always
takes. It is **gitignored**, with `apps/web/proxy.conf.example.mjs` committed as the contract
new contributors copy and adapt — the same generated/example split every other env surface in
this repo already uses.

It started as plain JSON in the gateway-integration milestone and was converted to a module on
2026-09-06 once [[2026-09-06-address-geocoding-proxy-design]] added a `/geocode/` route that
must append an API key at request time — JSON is declarative and cannot read `process.env` or a
file, while `@angular/build` loads any non-`.json` proxy path as a module and honours its
`default` export. The module reads `GEOAPIFY_API_KEY` from `.env.local.web`'s CUSTOM box at
request time (never interpolated into the generated file), the same box `apps/web/nginx.conf`
reads for the container path, so `ng serve` and the container never disagree about which key is
in play. See [[2026-09-07-a-dead-path-is-not-fail-closed-against-an-external-host]] for a trap
found converting the "key unset" branch to this shape.

**`GEOAPIFY_API_KEY`** (runtime, CUSTOM box) and **`NG_APP_GEOCODE_ENABLED`** (build-time,
default `false`) were added with [[2026-09-06-address-geocoding-proxy-design]]. They are
deliberately two separate values, not one: the key lives in `.env.local.web`'s CUSTOM box and
is read at request time by both `apps/web/nginx.conf` (container) and `apps/web/proxy.conf.mjs`
(`ng serve`) — never compiled into the bundle — while the flag is a build-time `NG_APP_*` var
controlling whether the UI offers autocomplete at all. Both must be set for the feature to
work — an unset key with the flag on 503s on every keystroke.

> [!warning] A build-time `NG_APP_*` var absent at build time is not "missing" — it throws
> `@ngx-env/builder` only inlines an `NG_APP_*` variable it can see at build time; one it
> cannot see is left as a live `import.meta.env.NG_APP_*` lookup in the shipped bundle, which is
> `undefined` in a browser and **throws before Angular boots** rather than falling back to a
> default — a `||` fallback never runs, because the throw happens evaluating its left operand.
> This bit `NG_APP_API_GATEWAY_URL`: `docker-compose.yml` passed it as a build arg, but
> `apps/web/Dockerfile` declared no matching `ARG`/`ENV` to receive it. Every `NG_APP_*` the app
> reads needs both an `ARG` and an `ENV` in the Dockerfile — see
> [[2026-09-04-a-build-time-env-var-absent-at-build-time-is-a-live-lookup]] for the full
> incident, including why unit tests, a clean build, and a 200 from the proxy all missed it.

`EVENTS_QUEUE_URL` (the shared SQS queue the events-pipeline consumes) is generated into **four**
files as of the events-pipeline milestone: `.env.local.events-pipeline` itself, plus
`.env.local.users`, `.env.local.orders`, and `.env.local.tracking` — each service's own producer
reads the same generated queue URL from its own file, never a shared or hardcoded one. See
[[events-pipeline-design]].

**`CACHE_ENABLED`** (added 2026-08-26, response-caching-layer milestone; previously missing
from this note) is generated into `.env.local.users`, `.env.local.orders`, and
`.env.local.tracking` as a **CUSTOM**, not AUTO, default (`true`) — deliberately, so a
per-machine choice survives `make env-file` regeneration and the cache A/B load test can flip
it without a run undoing the flip. `REDIS_HOST`/`REDIS_PORT` are generated into the same three
files as AUTO values, alongside it — see
[[2026-08-25-response-caching-layer-design]] and [[x-cache-response-header]].

> [!note] `MAILPIT_API_URL` in `.env.local.infra` is NOT a Terraform output
> Unlike its neighbours in that file, `MAILPIT_API_URL` is a fixed local constant
> (`http://localhost:8025/api/v1`, defined in `generate_env_files.py`) rather than something read
> from `terraform output`. Mailpit's port is published by docker-compose, not provisioned by
> Terraform, so there is no output to read. The E2E suite reads it to assert that the
> events-pipeline's emails actually land in the local inbox — see
> `e2e/support/mailpit-client.ts`.

`.env*` is git-ignored except `.env.example`, which needs an explicit `!.env.example` negation.

## Not every generated value is an env file — `EXECUTION_LOG_TABLE`

`EXECUTION_LOG_TABLE` names the DynamoDB table the `local-exec` provisioning scripts record
their runs to (traceability only — a record never skips a re-run; see
`infra/scripts/lib3mrai/execution_log.py`). It is the one infrastructure identifier in this repo
that is deliberately **not** in any generated env file, and this section exists so nobody looks
for it in `.env.local.infra` and concludes the generator dropped it.

It reaches its consumers by two paths, neither of them `generate_env_files.py`:

| Consumer | How it arrives |
|---|---|
| Scripts the Makefile invokes directly | `export EXECUTION_LOG_TABLE ?= 3mrai-local-tfstate-execution-log` (`Makefile:54`), exported like `AWS_ENDPOINT_URL` so `terraform` and every `local-exec` it spawns inherit it |
| Scripts a provisioner spawns | Each provisioner sets it explicitly in its own `environment` block from `var.execution_log_table` (`infra/environments/local/main.tf`, `post/gate.tf`, `post/grants.tf`, `post/assets.tf`, and the `cognito`/`redis`/`docdb` modules) |

Both paths carry the same literal, and the provisioners set it explicitly **on top of** the
Makefile's export so a by-hand `terraform apply` records too, without going through `make`.

> [!note] Why this one is a literal rather than a Terraform output
> The table is created by the `backend/` root (`infra/modules/tf-backend`), which keeps **local**
> state by design — it creates the S3 bucket every other root's backend points at. Phase 1's
> outputs are readable through `terraform_remote_state`; this root's are not, and reading them
> would need a `backend = "local"` data source hardcoding a relative path between two roots, a
> mechanism used nowhere else here. The name is deterministic
> (`"<context.id>-execution-log"`), so a literal is safe: `Makefile:54` uses `?=` to yield to an
> environment override, `infra/environments/local/variables.tf:91-103` carries the same value as
> a plain `default`, and the backend root exposes an `execution_log_table_name` output
> (`infra/environments/local/backend/outputs.tf`) to confirm it against.

**An unset value is a legitimate state, not a misconfiguration.** `execution_log.py` treats an
absent variable as "the log is not wired up" and runs the script exactly as it did before the log
existed, and the shared modules default `execution_log_table` to `""` because production never
runs these awscli-fallback scripts at all.

## Editing rule

Each generated file has two boxes: AUTO-GENERATED (rewritten on every run) and CUSTOM
(preserved). **Never edit the AUTO box** — it is overwritten without warning. Put overrides,
personal tokens, and local-only flags in CUSTOM.

Values with no consumer anywhere (today `APIDOG_ACCESS_TOKEN`/`APIDOG_PROJECT_ID`) belong in a
CUSTOM box rather than scattered around.

## Adding a service

1. Add a `.env.local.<service>` entry to
   `infra/environments/local/scripts/generate_env_files.py`.
2. Add `env_file: [.env.local.<service>]` to that service in `docker-compose.yml`.
3. Declare NOTHING inline in `environment:`.

There is deliberately no shared `.services` file: Users and Orders both define
`DATABASE_WRITER_URL` with different values AND different formats (a `postgres://` URL versus
an ADO connection string `Server=…;Port=…;`), so one file per service is what stops them
colliding. This already applies to `tracking` (`.env.local.tracking` exists, generated the same
way) and now also to `events-pipeline` (`.env.local.events-pipeline`), which landed with the
events-pipeline milestone (2026-08-04).

> [!note] Fixed 2026-08-26 — a new `custom_defaults` key now DOES reach an existing file
> This convention used to warn that a new `custom_defaults` key added to the generator would
> not retroactively appear in a file that already existed on disk, and told the reader to
> hand-edit the CUSTOM box or delete the file to work around it. **That gap is closed.**
> `infra/scripts/lib3mrai/envfile.py:100-126` (`write_env_file`) now seeds `custom_defaults`
> **per key**, not all-or-nothing: each default is appended to the existing CUSTOM box only
> when that exact key is absent from it (a commented-out line still counts as present, so a
> deliberately-disabled default is not silently re-enabled). A first run gets working defaults
> and later runs never overwrite what a developer changed, but a **new** key added to the
> generator after a file already exists on disk is now seeded into it on the next `make
> env-file`, with no hand-editing or file deletion required. This was fixed as part of JE-195
> (Redis access for Orders/Tracking, `CACHE_ENABLED` kill switch) — see the header comment on
> `write_env_file` for the reasoning.

## Four traps, all silent

Each of these cost real debugging time in this block:

1. **`environment:` beats `env_file:`.** A leftover inline entry silently overrides the
   generated value and reintroduces the duplication. Migrate a service completely or not at
   all.
2. **`${VAR}` with no value resolves to an empty string**, not an error. Moving one of the
   four interpolated vars out of the root `.env` breaks compose silently — the container gets
   `""`.
3. **`env_file:` does NOT interpolate.** Compose expands `${USERS_DB_PORT}` inside the compose
   file, but values in an env file are taken literally. The generator therefore resolves every
   port and id as it writes. A `${...}` left in a generated file reaches the service as that
   literal string.
4. **A dropped variable fails far from its cause.** `E2E_TESTING_ENABLED` was missed in the
   first migration and surfaced as three failing E2E tests asserting on an "E2E Source" tag —
   nothing pointed at the env file. When migrating, diff the generated file against the
   previous inline list with an indentation-agnostic match; a regex pinned to one indent level
   silently skipped that key and reported false parity.

## Verification

When changing env plumbing, verify against a real bring-up, not by inspection:

- `make infra-down` then `make bootstrap`, and confirm both services start with their env
  present INSIDE the container (`docker compose exec <svc> printenv <KEY>`).
- Full E2E must match the baseline (35 passed).
- Confirm a CUSTOM value survives regeneration while the AUTO box picks up fresh
  infrastructure ids.
- `.env.local.debug` is exercised by nothing else — connect with it manually (`pg_isready`,
  `mysqladmin ping`) or a wrong value goes unnoticed indefinitely.

## Related

- [[2026-07-20-env-file-generation-design]]
- [[scripting-language]]
- [[local-dev]]
- [[testing]]
- [[events-pipeline-design]] — `.env.local.events-pipeline` and `EVENTS_QUEUE_URL`'s propagation into three other services' env files.
- [[2026-08-03-events-pipeline-milestone-design]]
- [[2026-08-25-response-caching-layer-design]] — `CACHE_ENABLED`/`REDIS_HOST`/`REDIS_PORT`'s
  propagation into Orders' and Tracking's env files.
- [[x-cache-response-header]] — the `CACHE_ENABLED` kill switch's consumer contract.
- [[2026-09-04-web-gateway-integration-design]] — the design that added `.env.local.web` and
  the `ng serve` proxy, originally `apps/web/proxy.conf.json`/`proxy.conf.example.json`.
- [[web-gateway-integration-milestone]] — the milestone that shipped them.
- [[2026-09-04-a-build-time-env-var-absent-at-build-time-is-a-live-lookup]] — the missing-ARG/ENV
  incident behind the warning above.
- [[2026-09-06-address-geocoding-proxy-design]] — the design that added `GEOAPIFY_API_KEY` and
  `NG_APP_GEOCODE_ENABLED` to `.env.local.web`, and converted the `ng serve` proxy from JSON to
  `apps/web/proxy.conf.mjs`/`proxy.conf.example.mjs`.
- [[2026-09-07-a-dead-path-is-not-fail-closed-against-an-external-host]] — the `bypass`
  fail-closed trap found converting the proxy's "key unset" branch to the module shape.
- [[2026-07-30-post-infra-root-design]] — the design behind the execution log; it proposed
  emitting the table name into `.env.local.infra` as a `tf-backend` output, whereas the shipped
  path is the `Makefile` export plus per-provisioner `environment` blocks documented above.
- [[2026-07-30-post-infra-root]] — the plan that shipped the execution-log table and the
  `bootstrap`/`post-infra` split.
