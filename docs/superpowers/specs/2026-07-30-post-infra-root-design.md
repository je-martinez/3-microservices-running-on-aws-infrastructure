---
title: Post-Infra Root Design
type: spec
area: infra
status: draft
created: 2026-07-30
updated: 2026-07-30
tags:
  - type/spec
  - area/infra
  - status/draft
propagates-to:
  - "[[two-phase-terraform-apply]]"
  - "[[env-files]]"
related:
  - "[[two-phase-terraform-apply]]"
  - "[[scripting-language]]"
  - "[[env-files]]"
  - "[[2026-07-15-two-phase-post-effects-design]]"
  - "[[testing]]"
---

# Post-Infra Root Design

## Summary

Split `make bootstrap` into two commands: `bootstrap` (brings up a *usable* environment —
services running, connecting as the cluster superuser `test`, data seeded) and a new
`post-infra` (*hardens* it — grants the phase-2 provider its required privileges, applies phase
2's least-privilege app-users). Move the phase-2-only MySQL GRANTs out of
`create_mysql_database.py`, where they currently live only because that script happens to run as
root, and into the post-infra root, where they are actually used. Add a DynamoDB execution log
for the four provisioning scripts that mutate state after their resources already exist, purely
for traceability — explicitly NOT to skip re-execution.

**Scope is deliberately bounded.** This is approach B of three options presented to the user.
The more ambitious option — splitting `DATABASE_WRITER_URL` into separate runtime and migration
URLs so Orders/Users/Tracking connect as their least-privilege app-users instead of the cluster
superuser — was explicitly rejected for this round. See [Out of scope](#out-of-scope-the-runtime-url-split).

## Current state (verified today, 2026-07-30)

`infra/environments/local/post/` already exists as Terraform's "phase 2": its own S3-backed
state (`local/phase2/terraform.tfstate`, distinct from phase 1's `local/terraform.tfstate`), its
own providers (`postgresql`, `mysql`, configured against the live cluster endpoints phase 1
produced), a `terraform_data.wait_for_db` gate (`gate.tf` + `scripts/wait_for_db.py`), and the
`db-app-user` module instantiated per engine. `make bootstrap` runs it as the **final** step of a
twelve-command chain (`floci` → `backend-up` → `infra-init` → `infra-up` → `migrate` →
`users` up → `bootstrap.py` → `infra-up-post` → `orders` up → `migrate-tracking` → `tracking`
up), per the current Makefile. A failure in `infra-up-post` — the last Terraform step, after
every service dependency has already been paid for — is the hardest failure in the chain to
diagnose, because everything that ran before it succeeded.

Two concrete defects were verified by reading the code:

### Defect 1 — privileges live in the wrong script

`infra/environments/local/scripts/create_mysql_database.py` runs during **phase 1** (it is what
gives the `tracking` database its own schema on the shared MySQL cluster, since
`aws_rds_cluster.database_name` only creates one database per cluster). It connects as MySQL
`root` — Floci's only reachable MySQL superuser — because at the time it runs, that is the only
identity capable of `CREATE DATABASE`. Its `_sql()` function grants three things to `test` (the
app-visible superuser both services actually connect as):

```sql
GRANT ALL PRIVILEGES ON `tracking`.* TO 'test'@'%' WITH GRANT OPTION;
GRANT CREATE USER ON *.* TO 'test'@'%';
GRANT SELECT ON mysql.* TO 'test'@'%';
```

The comment on the last two lines is explicit about why they are there: **"Phase 2 configures the
mysql provider as this same user … Without them `make infra-up-post` fails: first 1227 on CREATE
USER, then 1142 reading `mysql.user` to diff the grants it just wrote."** These GRANTs have
nothing to do with creating the `tracking` database — the phase-1 script's stated job. They exist
in phase 1 purely because phase 1 is the only place currently running as `root`. Verified today:
removing them from `create_mysql_database.py` without adding them anywhere else reproduces
exactly that failure sequence — 1227 first, then 1142 once the first is worked around.

### Defect 2 — no record of what provisioning scripts ran

Four scripts run as `local-exec` provisioners, after the Terraform resources they depend on
already exist, outside Terraform's own resource lifecycle (the awscli-fallback pattern, see
[[awscli-fallback-for-floci]]):

| Script | Runs against |
|---|---|
| `infra/environments/local/scripts/create_mysql_database.py` | the MySQL cluster, as root |
| `infra/modules/cognito/scripts/create_user_pool_client.py` | the Cognito user pool |
| `infra/modules/cognito/scripts/set_pre_token_trigger.py` | the Cognito user pool |
| `infra/environments/local/post/scripts/wait_for_db.py` | both DB endpoints (a healthcheck, not a mutation) |

Nothing records whether any of these ran, against what resource identity, or whether they
succeeded. Each is already idempotent on its own terms (`CREATE DATABASE IF NOT EXISTS`, Cognito
client lookup-then-reuse, `UpdateUserPool` is declarative), so nothing is currently *broken* — but
there is no way to answer "did the MySQL grants actually get applied to this cluster, and when"
without re-running the script and reading its stdout in the moment. That evidence disappears the
instant the terminal scrolls past it.

## Decisions

### 1. Split `make bootstrap` into `bootstrap` and `post-infra`

`make bootstrap` stops calling `infra-up-post`. It ends with the stack in a state that is
**usable**: Floci up, phase-1 infra applied, env files generated, migrations run, all three
services up (`users`, `orders`, `tracking`), Orders' seed data present via `SEED_ON_STARTUP`. All
of that already happens before `infra-up-post` in the current chain — removing the last step does
not remove any of it.

`make post-infra` becomes a new, separate, explicit target that *hardens* an already-bootstrapped
environment: it moves the MySQL GRANTs (decision 2, below) into its own step, then runs what
`infra-up-post` runs today — creating `users_app` (Postgres), `orders_app` and `tracking_app`
(MySQL) as least-privilege, no-DELETE app-users (per [[ADR-0004-soft-delete-only|soft-delete-only]],
referenced from [[two-phase-terraform-apply]]).

Each command is now statable in one sentence: `bootstrap` brings up a working environment;
`post-infra` hardens it. A failure in `post-infra` is diagnosed against a stack that is already
known-good, rather than against a stack still being assembled.

`docker compose`, `env-file`, and every other existing target are unaffected — only the last
step's ownership moves from `bootstrap` to a new target `bootstrap` no longer calls.

### 2. Move the GRANTs to the post-infra root

The three GRANT statements move out of `create_mysql_database.py`'s `_sql()` function and into a
new script colocated with the post-infra root (`infra/environments/local/post/scripts/`,
following [[scripting-language]]'s "scripts stay colocated with the Terraform module that invokes
them" rule) that runs as the **first** step of `make post-infra`, before the `mysql` provider is
configured against the cluster. `create_mysql_database.py` keeps `CREATE DATABASE IF NOT EXISTS`
and its existing `GRANT ALL PRIVILEGES ON tracking.* TO 'test'@'%'` (that one **is** about the
database it creates — it stays), and drops only the two provider-enablement grants
(`CREATE USER`, `SELECT ON mysql.*`) that belonged to phase 2 all along.

This is a pure move, not a new capability: the same DDL runs, as the same `root` identity, over
the same throwaway `mysql:8` client container joined to Floci's compose network — only the
script that issues it, and the phase in which it runs, change. `create_mysql_database.py`'s job
becomes exactly what its docstring already claims it is for (creating the `tracking` database),
with no drive-by phase-2 concern smuggled in because it happened to have root.

### 3. A DynamoDB execution log — for traceability, NOT for skipping

This is the design's central decision and needs to be argued, not just stated.

**The three state-mutating scripts (MySQL grants/database, Cognito client, Cognito trigger) are
already idempotent.** `create_mysql_database.py` uses `CREATE DATABASE IF NOT EXISTS` and
re-issues the same GRANTs, which MySQL treats as a no-op if already held.
`create_user_pool_client.py` looks up an existing client by name before creating one.
`set_pre_token_trigger.py`'s `UpdateUserPool` is declarative — applying it twice with the same
inputs yields the same pool state. And Terraform itself already gates whether these `local-exec`
provisioners re-run at all, via `terraform_data.input` hashing: if the input is unchanged, the
provisioner does not re-fire on a subsequent `plan`/`apply`.

Given that, a design that recorded "script X already ran" and used that record to **skip**
re-running X would not be adding safety — it would be **introducing a hazard that does not exist
today**. `make clean` routinely destroys and recreates the underlying resources (the MySQL
cluster, the Cognito pool) while leaving old script-run history around in a hypothetical log. A
skip-on-record design would read that stale history, conclude "already done," and leave the
*new* cluster or pool without its grants/client/trigger — a silently broken environment that
looks provisioned but is missing state a human would have to discover by hand. The scripts
already resolved the idempotency problem correctly (rerun and let the underlying system no-op);
the log must not re-introduce a worse solution to a problem that no longer exists.

So: **the wrapper always executes the script's existing logic. It never skips. It only records
the outcome**, before and after, for traceability — so a person or an agent can answer "when did
this last run, against which resource, and did it succeed" without re-running anything or
scrolling back through a terminal.

#### Record key

**Script name plus the identity of the resource it ran against** (cluster id for the MySQL
grants/database scripts, user pool id for the two Cognito scripts), plus a timestamp. Not
script-name-plus-timestamp alone — the resource identity is what keeps history meaningful across
a `make clean`. `make clean` destroys and recreates the cluster and pool, and Floci mints new ids
for both. A recreated cluster gets a **new** cluster id, so its records start a fresh history
under a different key; the old cluster's records stay in the table, correctly attributed to a
resource that no longer exists, rather than being confused for current state. A
script-plus-timestamp key would still record *a* timestamp, but nothing in the key would
distinguish "ran against the cluster that exists now" from "ran against a cluster three
`make clean` cycles ago" without inspecting record contents — the resource id in the key makes
that distinction free.

#### Record contents

- script name
- content hash of the script (detects "the script changed since this record was written," useful
  when comparing a record against the script that would run now)
- start timestamp, end timestamp
- exit code
- stderr, on failure only
- resource identity (the same value used in the key)
- status: starts `running`, closes to `ok` or `failed`

The `running` → `ok`/`failed` transition is deliberate: a record permanently stuck at `running` is
legible evidence that a run was interrupted (killed, machine slept, `make` interrupted with
Ctrl-C) rather than a mystery — the alternative (writing the record only at the end) would leave
no trace at all of an interrupted run, which is strictly worse for traceability than an
occasionally-stale `running` row.

#### Table location

`infra/modules/tf-backend/`, the module that already creates `3mrai-local-tfstate-lock`
(`aws_dynamodb_table.this` in `main.tf`) and runs **first**, before phase 1. This is not
incidental: phase-1 scripts (the Cognito ones, `create_mysql_database.py`) run before
`environments/local/post/` exists as a Terraform root at all, so a table declared inside the
post-infra root would be a chicken-and-egg — the phase-1 scripts would need a table that isn't
created until after phase 2 applies. `tf-backend` already runs before everything else
(`make backend-up`, the first step of `make bootstrap`), so a second table declared alongside the
lock table is available to every script from the start of the chain. Verified today that DynamoDB
itself works against Floci (the lock table already proves it, in production use since
[[2026-07-17-terraform-remote-state-backend-design]]).

#### Wrapper shape

A context-manager helper added to `infra/scripts/lib3mrai/` (a new module, alongside `aws.py`,
`console.py`, `db.py`, `envfile.py`), used like:

```python
from lib3mrai.execution_log import record_execution

with record_execution(script="create_mysql_database.py", resource_id=cluster_id):
    ...existing script logic, unchanged...
```

Each of the four scripts wraps its existing `main()` body in this context manager. It is **not**
a separate wrapper script that Terraform's `local-exec` invokes instead of the script itself —
the four `local-exec` command lines in the `.tf` files stay exactly as they are today. The
context manager writes the `running` record on entry, and the `ok`/`failed` record (with exit
code / stderr as applicable) on exit, re-raising whatever exception the wrapped body raised so
the script's own exit-code contract (documented in each script's docstring, e.g.
`wait_for_db.py`'s "0 ready, 1 timeout, 2 unknown engine or usage error") is preserved unchanged.

#### Failure semantics

Two independent failure modes, handled differently on purpose:

- **DynamoDB is unreachable.** The helper catches the failure, prints a warning to stderr (via
  `lib3mrai.console.no`, matching the existing convention), and lets the wrapped script run
  anyway. A traceability mechanism that can abort provisioning because its *own* logging
  dependency is down is worse than one that occasionally loses a record — the log is a diagnostic
  aid, not a gate. Provisioning must not become newly fragile because of it.
- **The wrapped script itself fails.** The record closes with `status: failed`, the exit code,
  and stderr, and the original exception/exit code propagates exactly as it does today. The log
  changes nothing about control flow here either — it only observes and records the failure that
  was already going to happen.

The two modes must not be conflated: a DynamoDB outage is a reason to warn and continue running
the script; a script failure is a reason to fail exactly as loudly as before, now with a record of
it.

#### The table's name reaches consumers via the env file generator

`generate_env_files.py` (see [[env-files]]) already reads Terraform outputs from `tf-backend` (the
lock-table name is implicitly available the same way once exposed as an output) and writes
`.env.local.infra`. The execution-log table's name is added as a `tf-backend` output and emitted
into that same file, so a human (or a future script/agent) can find and query the table without
hardcoding its name — consistent with how every other Floci-minted identifier in this repo is
already treated as generated, never hand-copied.

### 4. Seeds stay where they are

Orders seeds on startup today, gated by `SEED_ON_STARTUP=true` in compose — the API applies EF
Core migrations then `ProductSeed` before serving, already inside `make bootstrap`. Moving seeding
into `post-infra` was considered and rejected: it would leave a freshly-bootstrapped environment
with no data until a second command runs, which contradicts the definition of `bootstrap` in
decision 1 (it must end *usable*, and a service with no seed data to list is not fully usable for
manual testing or E2E). Seeding stays exactly where it is; this design does not touch it.

## What happens if `post-infra` runs before `bootstrap`

`post-infra`'s first step (the moved MySQL GRANTs) and the `db-app-user` modules both depend on
resources phase 1 creates: the MySQL cluster (for the GRANTs) and both cluster endpoints plus the
master-credentials secret ARN (for the `postgresql`/`mysql` providers, read via
`terraform_remote_state` against phase 1's state file). If phase 1 has never been applied, phase
2's `terraform_remote_state` data source fails to read a state file that does not exist yet, and
Terraform fails at plan time with a clear "no state file found" / remote-state read error — before
any provisioner runs, and before the DynamoDB log is touched. This is the existing behavior of
`terraform_remote_state` and requires no new code: the fix is documentation, not a code path. The
Makefile's `post-infra` target help text and `infra/environments/local/post/README.md` state the
dependency explicitly (`post-infra` requires a successful `bootstrap` first) so the failure, when
it happens, is expected rather than surprising — Terraform's own error is already unambiguous, it
just isn't currently explained anywhere that a human reads before running the command.

If `bootstrap` completed a phase-1 apply and was then torn down partially (e.g. `infra-down`
without a full `clean`), the same remote-state read fails the same way — the guarantee is "phase 1
state must exist and be current," not "bootstrap was the literal most recent command run."

## Out of scope: the runtime URL split

A more ambitious option was on the table: splitting `DATABASE_WRITER_URL` into a **migration**
URL (cluster superuser, used only for `prisma migrate deploy` / `alembic upgrade head` / EF Core
migrations, all of which run DDL) and a **runtime** URL (the least-privilege app-user phase 2
already creates, used by the running services). This was explicitly rejected for this round of
work, at the user's direction, as too risky to bundle in:

- **Five files across three services** currently read `DATABASE_WRITER_URL` as a single value:
  `services/orders/src/Orders.Api/Program.cs`, three files in `services/users`, and
  `services/tracking/alembic/env.py`.
- The app-users hold no DDL grant by design (soft-delete-only, per
  [[ADR-0004-soft-delete-only|soft-delete-only]]) — getting the ordering wrong (e.g. a migration
  step accidentally reading the runtime URL) breaks migrations at startup, which is a
  service-availability failure, not a hardening nicety.
- `infra/environments/local/post/README.md` already documents this exact gap ("Services do not
  use these MySQL users yet") as blocked on ordering, not on the provider — this design does not
  change that state.

The app-users this design's `post-infra` creates (`users_app`, `orders_app`, `tracking_app`) are
left exactly as created-and-ready as they are today. Wiring services to connect as them is a
later, separate change, out of scope here by explicit decision, not by oversight.

## Verification

Per [[testing]], this design changes no HTTP endpoint, so the three-layer endpoint convention
does not apply. What needs verification is the Makefile split and the new helper:

- `make bootstrap` (with `post-infra` never run) still brings up all three services, connecting as
  the cluster superuser, with Orders' seed data present — unchanged from today's `bootstrap`
  minus its final step.
- `make post-infra`, run after a successful `bootstrap`, applies the moved GRANTs, then creates
  all three app-users with no drift on a second `plan` — unchanged behavior from today's
  `infra-up-post`, just under a new name and with the GRANTs relocated ahead of it.
- `make post-infra`, run **without** a prior `bootstrap` (or after `infra-down`), fails at the
  `terraform_remote_state` read, before any provisioner runs — per
  [What happens if `post-infra` runs before `bootstrap`](#what-happens-if-post-infra-runs-before-bootstrap).

For the execution-log helper specifically — this is the new code, so it is what needs tests, not
the four scripts it wraps (already covered by their own idempotency, argued above):

1. **A successful run is recorded.** Wrapping a no-op success writes a `running` record, then an
   `ok` record with the correct resource identity, script name, content hash, and both
   timestamps.
2. **A failed run is recorded with its error.** Wrapping a body that raises writes a `failed`
   record capturing exit code and stderr, and the original exception still propagates to the
   caller (Terraform still sees the same failure it would see without the wrapper).
3. **DynamoDB being unreachable does not break the script.** With the table unreachable (wrong
   endpoint, table missing, or credentials invalid), the wrapped body still runs to completion
   and its result is still returned/raised normally; only a stderr warning is emitted. This third
   case is the concrete guarantee the whole failure-semantics decision (§3, "Failure semantics")
   rests on — it is not enough to assert that the design fails open, it must be demonstrated.

## Related

- [[two-phase-terraform-apply]]
- [[scripting-language]]
- [[env-files]]
- [[2026-07-15-two-phase-post-effects-design]]
- [[testing]]
