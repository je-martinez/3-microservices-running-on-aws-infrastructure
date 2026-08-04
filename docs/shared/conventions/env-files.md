---
title: Env Files
type: convention
area: infra
status: active
created: 2026-07-20
updated: 2026-08-04
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
| `.env.local.infra` | Terraform outputs (Cognito ids, API GW url, DB hosts/ports) | the E2E suite, humans |
| `.env.local.users` | the Users service environment | compose `env_file:` |
| `.env.local.orders` | the Orders service environment | compose `env_file:` |
| `.env.local.tracking` | the Tracking service environment (incl. `E2E_TESTING_ENABLED=true` in CUSTOM, `EVENTS_QUEUE_URL`) | compose `env_file:` |
| `.env.local.events-pipeline` | the events-pipeline Lambda environment (DocumentDB connection, `EVENTS_QUEUE_URL`, SES sender) | the Lambda's environment variables, set via Terraform |
| `.env.local.debug` | HOST-reachable connection strings | a SQL client; **loaded by nothing** |
| `.env.example` | the committed contract | documentation only |

`EVENTS_QUEUE_URL` (the shared SQS queue the events-pipeline consumes) is generated into **four**
files as of the events-pipeline milestone: `.env.local.events-pipeline` itself, plus
`.env.local.users`, `.env.local.orders`, and `.env.local.tracking` — each service's own producer
reads the same generated queue URL from its own file, never a shared or hardcoded one. See
[[events-pipeline-design]].

`.env*` is git-ignored except `.env.example`, which needs an explicit `!.env.example` negation.

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

> [!warning] A new `custom_default` does not reach an existing file
> `generate_env_files.py`'s CUSTOM box is preserved **verbatim** on regeneration — by design, so a
> developer's local overrides survive a re-run. That means adding a **new** `custom_defaults` key
> to the generator does not retroactively appear in a file that already exists on disk; only a
> freshly-generated file gets it. To pick up a new default, either add the line to the existing
> CUSTOM box by hand, or delete the file so `make env-file` regenerates it from scratch. Seen live
> when `E2E_TESTING_ENABLED` was added to `.env.local.tracking`'s defaults.

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
