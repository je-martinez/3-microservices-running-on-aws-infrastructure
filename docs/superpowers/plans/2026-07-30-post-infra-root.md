---
title: "Post-Infra Root"
type: plan
area: infra
status: draft
created: 2026-07-30
updated: 2026-07-30
tags: [type/plan, area/infra, status/draft]
propagates-to:
  - "[[two-phase-terraform-apply]]"
  - "[[env-files]]"
related: ["[[2026-07-30-post-infra-root-design]]", "[[two-phase-terraform-apply]]", "[[scripting-language]]", "[[env-files]]", "[[2026-07-15-two-phase-post-effects-design]]", "[[testing]]"]
---

# Post-Infra Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `make bootstrap` (ends usable) from a new `make post-infra` (hardens it), move
the MySQL GRANTs that only phase 2 needs out of the phase-1 database-creation script, and add a
DynamoDB execution log so the four post-resource provisioning scripts record what ran, against
what, and whether it succeeded — without ever using that record to skip re-execution.

**Architecture:** A new `execution_log` table, declared in `infra/modules/tf-backend/` (the
module that already creates the lock table and runs first, via `infra/environments/local/backend/`).
A new `infra/scripts/lib3mrai/execution_log.py` context manager, imported by the four scripts that
already run as `local-exec` provisioners. A relocated GRANT step at the front of `make post-infra`.
A `Makefile` split that removes `infra-up-post` from `bootstrap`'s chain and exposes it (renamed
`post-infra`) as an explicit, separately documented target.

**Tech Stack:** Terraform (AWS provider `= 5.31.0`, boto3), Python (`lib3mrai`), the existing
`mysql:8` throwaway-container pattern, Make.

## Global Constraints

- **No service code changes.** This plan touches `infra/` and the root `Makefile` only — the
  services/`DATABASE_WRITER_URL` split is explicitly out of scope (see the design's
  [Out of scope](../specs/2026-07-30-post-infra-root-design.md#out-of-scope-the-runtime-url-split)
  section).
- **The four `local-exec` command lines in the `.tf` files do not change.** Only the Python
  bodies they invoke gain a wrapping context manager; Terraform's view of each provisioner is
  unaffected.
- **The wrapper never skips execution.** It only records outcomes. If DynamoDB is unreachable it
  warns to stderr and lets the wrapped script run regardless — see [[scripting-language]] for the
  console-helper convention (`ok`/`no`/`inf`) it reuses.
- **Language:** converse in Spanish; write config/code/comments in English.
- **Scripts stay Python, colocated with the module that invokes them**; only the shared
  `execution_log` helper goes in `infra/scripts/lib3mrai/`, per [[scripting-language]].
- **Implementer writes only Terraform/Python/Makefile/docs.** Leave work in the working tree; the
  main session commits.
- Each task below leaves the repo in a working state — `terraform validate` passing, existing
  targets unbroken — even if the full chain isn't exercised until the last task.

---

## Task 1: `execution_log` DynamoDB table in `tf-backend`

**Files:**
- Modify: `infra/modules/tf-backend/main.tf`
- Modify: `infra/modules/tf-backend/variables.tf`
- Modify: `infra/modules/tf-backend/outputs.tf`

**Interfaces:**
- Consumes: `var.context` (already present), a new `var.execution_log_table_name` (nullable
  override, same pattern as `table_name`).
- Produces: `aws_dynamodb_table.execution_log`, output `execution_log_table_name`.

- [ ] **Step 1: Add the table resource**

In `infra/modules/tf-backend/main.tf`, add alongside the existing `local.table_name`:

```hcl
locals {
  bucket_name           = coalesce(var.bucket_name, "${var.context.id}-state")
  table_name            = coalesce(var.table_name, "${var.context.id}-lock")
  execution_log_table   = coalesce(var.execution_log_table_name, "${var.context.id}-execution-log")
}
```

Then add the table itself, after `aws_dynamodb_table.this`:

```hcl
# ─── Provisioning Script Execution Log ────────────────────────────────────────
# Traceability for the awscli-fallback local-exec scripts (see
# docs/shared/patterns/awscli-fallback-for-floci.md) — NOT a skip-on-record
# cache. Every wrapped script ALWAYS runs; this table only records the outcome.
# Key: script name (partition) + "<resource_id>#<timestamp>" (sort), so a
# recreated resource (e.g. after `make clean`) starts a fresh, distinguishable
# history instead of colliding with the old resource's records.
resource "aws_dynamodb_table" "execution_log" {
  name         = local.execution_log_table
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "script_name"
  range_key    = "run_key"

  attribute {
    name = "script_name"
    type = "S"
  }

  attribute {
    name = "run_key"
    type = "S"
  }

  tags = merge(var.context.tags, { Name = local.execution_log_table })
}
```

- [ ] **Step 2: Add the variable**

In `infra/modules/tf-backend/variables.tf`, add after `table_name`:

```hcl
variable "execution_log_table_name" {
  description = "Explicit override for the execution-log DynamoDB table name. Defaults to \"<context.id>-execution-log\" when null."
  type        = string
  default     = null
}
```

- [ ] **Step 3: Add the output**

In `infra/modules/tf-backend/outputs.tf`, add after `lock_table_name`:

```hcl
output "execution_log_table_name" {
  description = "Name of the DynamoDB table used to record provisioning-script execution history."
  value       = aws_dynamodb_table.execution_log.name
}
```

- [ ] **Step 4: Wire the output through `environments/local/backend/`**

`infra/environments/local/backend/outputs.tf` re-exports `module.tf_backend`'s outputs today
(`bucket_name`, `lock_table_name`). Add the same pass-through:

```hcl
output "execution_log_table_name" {
  description = "DynamoDB table for provisioning-script execution history."
  value       = module.tf_backend.execution_log_table_name
}
```

- [ ] **Step 5: Validate**

```bash
cd infra/modules/tf-backend && terraform init -backend=false >/dev/null && terraform validate
cd ../../environments/local/backend && terraform validate
```

Expected: `Success! The configuration is valid.` for both.

- [ ] **Step 6: Apply against Floci and confirm the table exists**

```bash
make backend-up
aws --endpoint-url http://localhost:4566 dynamodb describe-table --table-name 3mrai-local-tfstate-execution-log --query 'Table.TableStatus'
```

Expected: `"ACTIVE"`. (Table name follows the existing `<context.id>-*` convention —
`module.label.id` for this root is `3mrai-local-tfstate`, matching the existing
`3mrai-local-tfstate-lock` lock table.)

- [ ] **Step 7: Commit**

```bash
git add infra/modules/tf-backend infra/environments/local/backend/outputs.tf
git commit -m "feat(infra): add execution-log DynamoDB table to tf-backend"
```

---

## Task 2: `lib3mrai.execution_log` — the wrapper helper

**Files:**
- Create: `infra/scripts/lib3mrai/execution_log.py`
- Modify: `infra/scripts/lib3mrai/__init__.py` (export, if the package re-exports submodules —
  check existing pattern before adding)

**Interfaces:**
- Consumes: `AWS_ENDPOINT_URL`/`AWS_DEFAULT_REGION`/credentials via `lib3mrai.aws.client` (same
  factory every other script already uses); a new env var `EXECUTION_LOG_TABLE` naming the
  table (mirrors how `AWS_ENDPOINT_URL` is already threaded through the Makefile/Terraform).
- Produces: `record_execution(script, resource_id)`, a context manager.

- [ ] **Step 1: Write the helper**

Create `infra/scripts/lib3mrai/execution_log.py`:

```python
"""Traceability log for the awscli-fallback local-exec scripts.

NOT a skip-on-record cache — see docs/shared/patterns/awscli-fallback-for-floci.md
and the "DynamoDB execution log" section of
docs/superpowers/specs/2026-07-30-post-infra-root-design.md for why: the four
scripts this wraps are already idempotent on their own terms (CREATE ... IF NOT
EXISTS, lookup-then-reuse, declarative UpdateUserPool), and `make clean` destroys
and recreates the underlying resources routinely. A record that caused a skip
would leave a recreated resource unprovisioned while looking "already done" —
strictly worse than today. So `record_execution` NEVER skips; it always lets the
wrapped block run, and only records the outcome.

Key shape: partition key `script_name`, sort key `run_key` = "<resource_id>#<start
timestamp, ISO 8601>" — the resource id keeps a recreated resource's history
distinguishable from its predecessor's without needing to inspect record bodies.

Failure semantics:
  - DynamoDB unreachable: warn to stderr (lib3mrai.console.no) and let the
    wrapped block run anyway. A traceability aid must not make provisioning
    newly fragile.
  - The wrapped block raises: the record closes as "failed" with the exception's
    string and re-raises unchanged — callers see the exact same failure they
    would without this wrapper.
"""

from __future__ import annotations

import contextlib
import hashlib
import inspect
import os
import time
import traceback
from datetime import datetime, timezone

from lib3mrai import aws
from lib3mrai.console import no

TABLE_ENV_VAR = "EXECUTION_LOG_TABLE"


def _table_name() -> str | None:
    return os.environ.get(TABLE_ENV_VAR) or None


def _content_hash(path: str) -> str:
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()[:16]
    except OSError:
        return "unavailable"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextlib.contextmanager
def record_execution(script: str, resource_id: str):
    """Wrap a provisioning script's body. ALWAYS runs the body — see module docstring.

    `script` — the script's own filename (e.g. "create_mysql_database.py").
    `resource_id` — identity of the resource acted on (cluster id, user pool id).
    """
    table = _table_name()
    start = _now()
    run_key = f"{resource_id}#{start}"

    # Resolve the calling script's own file path for the content hash, without
    # requiring every caller to pass it explicitly.
    caller_file = inspect.stack()[1].filename
    content_hash = _content_hash(caller_file)

    item = {
        "script_name": {"S": script},
        "run_key": {"S": run_key},
        "resource_id": {"S": resource_id},
        "content_hash": {"S": content_hash},
        "started_at": {"S": start},
        "status": {"S": "running"},
    }

    ddb = None
    if table is not None:
        try:
            ddb = aws.client("dynamodb")
            ddb.put_item(TableName=table, Item=item)
        except Exception as exc:  # noqa: BLE001 — traceability must not be fragile
            no(f"execution_log: could not write 'running' record: {exc}")
            ddb = None

    failed_with: str | None = None
    try:
        yield
    except Exception as exc:  # noqa: BLE001 — re-raised below unchanged
        failed_with = "".join(
            traceback.format_exception_only(type(exc), exc)
        ).strip()
        raise
    finally:
        end = _now()
        status = "failed" if failed_with else "ok"
        if table is not None:
            try:
                ddb = ddb or aws.client("dynamodb")
                update = {
                    ":status": {"S": status},
                    ":ended_at": {"S": end},
                }
                expr = "SET #s = :status, ended_at = :ended_at"
                if failed_with:
                    update[":stderr"] = {"S": failed_with[:2000]}
                    expr += ", stderr = :stderr"
                ddb.update_item(
                    TableName=table,
                    Key={"script_name": {"S": script}, "run_key": {"S": run_key}},
                    UpdateExpression=expr,
                    ExpressionAttributeNames={"#s": "status"},
                    ExpressionAttributeValues=update,
                )
            except Exception as exc:  # noqa: BLE001 — same fail-open rule
                no(f"execution_log: could not write '{status}' record: {exc}")
```

- [ ] **Step 2: Check `__init__.py` export style before touching it**

```bash
cat infra/scripts/lib3mrai/__init__.py
```

If it re-exports submodule names (e.g. `from . import aws, console, db, envfile`), add
`execution_log` to that list for consistency. If it's empty/minimal, leave it — importers already
use `from lib3mrai.execution_log import record_execution` explicitly, matching how `envfile`/`db`
are imported elsewhere.

- [ ] **Step 3: Syntax/import check**

```bash
.venv/bin/python -c "from lib3mrai.execution_log import record_execution; print('import ok')"
```

(Requires `make scripts-setup` already run so `lib3mrai` is installed editable in `.venv`.)

Expected: `import ok`.

- [ ] **Step 4: Commit**

```bash
git add infra/scripts/lib3mrai/execution_log.py infra/scripts/lib3mrai/__init__.py
git commit -m "feat(infra): add lib3mrai.execution_log traceability wrapper"
```

---

## Task 3: Unit tests for the wrapper — the three required cases

**Files:**
- Create: `infra/scripts/tests/test_execution_log.py` (check for an existing `tests/` layout
  under `infra/scripts/` first; match its conventions — pytest is the presumed runner given
  `infra/scripts` is an installable package)

**Interfaces:**
- Consumes: `record_execution`, a fake/mocked DynamoDB client (via `unittest.mock` or `moto` if
  already a dependency — check `infra/scripts/pyproject.toml`/`setup.cfg` first; do not add a new
  dependency without checking scope).

- [ ] **Step 1: Check for prior art**

```bash
find infra/scripts -iname "test_*" -o -iname "*_test.py"
cat infra/scripts/pyproject.toml 2>/dev/null || cat infra/scripts/setup.py 2>/dev/null
```

If a test runner/framework is already declared, use it. If none exists, add `pytest` as a dev
dependency (smallest addition that makes the three required cases automatable) and a minimal
`tests/` package.

- [ ] **Step 2: Test — a successful run is recorded**

Mock `lib3mrai.aws.client("dynamodb")` (patch `lib3mrai.execution_log.aws.client`). Set
`EXECUTION_LOG_TABLE` in the test environment. Run:

```python
with record_execution(script="fake.py", resource_id="cluster-123"):
    pass  # success
```

Assert: `put_item` called once with `status="running"`, resource_id `"cluster-123"`; `update_item`
called once with `status="ok"` and an `ended_at` present, no `stderr` key.

- [ ] **Step 3: Test — a failed run is recorded with its error, and re-raises**

```python
with pytest.raises(RuntimeError):
    with record_execution(script="fake.py", resource_id="cluster-123"):
        raise RuntimeError("boom")
```

Assert: `update_item` called with `status="failed"` and a `stderr` value containing `"boom"`; the
`RuntimeError` propagates out of the `with` block (the test itself asserts this via
`pytest.raises`).

- [ ] **Step 4: Test — DynamoDB unreachable does not break the wrapped script**

Make the mocked client's `put_item` (and `update_item`) raise (e.g. `botocore.exceptions.EndpointConnectionError`
or a plain `Exception`, simulating unreachability). Run:

```python
ran = False
with record_execution(script="fake.py", resource_id="cluster-123"):
    ran = True
assert ran is True
```

Assert: the body still executed (`ran is True`), no exception propagated from the context manager
itself, and a warning was printed to stderr (capture via `capsys`/`caplog` matching
`lib3mrai.console.no`'s format). This is the concrete guarantee the whole failure-semantics
decision rests on — do not skip this case.

- [ ] **Step 5: Run the tests**

```bash
.venv/bin/python -m pytest infra/scripts/tests/test_execution_log.py -v
```

Expected: 3 passed (plus the successful-run and failed-run cases from Steps 2-3 — at minimum 3
tests total, one per required case).

- [ ] **Step 6: Commit**

```bash
git add infra/scripts/tests infra/scripts/pyproject.toml
git commit -m "test(infra): cover execution_log success, failure, and DynamoDB-unreachable cases"
```

---

## Task 4: Wire the four scripts to use the wrapper

**Files:**
- Modify: `infra/environments/local/scripts/create_mysql_database.py`
- Modify: `infra/modules/cognito/scripts/create_user_pool_client.py`
- Modify: `infra/modules/cognito/scripts/set_pre_token_trigger.py`
- Modify: `infra/environments/local/post/scripts/wait_for_db.py`

**Interfaces:**
- Each script's `main()` body wraps its existing logic in
  `with record_execution(script=<own filename>, resource_id=<cluster/pool id>): ...` — no change
  to CLI args, exit codes, or stdout contract (per [[scripting-language]]'s "preserve external
  interfaces when porting" rule, applied here to wrapping rather than porting).

- [ ] **Step 1: `create_mysql_database.py`**

Wrap the body of `create_database(...)`'s call site inside `main()` (the resource id is the
database name it's a distinguishing enough identity, but the design calls for **cluster identity**
— use the MySQL cluster id if available from an env var already passed by the `local-exec`
provisioner; if not currently passed, check the calling `.tf` resource and add it as an env var
input rather than inventing a new discovery path). At minimum:

```python
from lib3mrai.execution_log import record_execution

...

def main(argv: list[str]) -> int:
    ...
    with record_execution(script="create_mysql_database.py", resource_id=cluster_identity):
        inf(f"creating MySQL database '{args.database}' on {FLOCI_HOST}:{port} …")
        if not create_database(args.database, port):
            raise RuntimeError(f"failed to create database '{args.database}'")
    ok(f"MySQL database '{args.database}' present (granted to '{APP_USER}')")
    return 0
```

Note: `create_database` currently returns `False` on failure rather than raising — the wrapper
needs an exception to detect failure, so this is the one behavioral seam: translate the `False`
return into a raised exception inside the `with` block so `record_execution` sees it, then let the
existing `no(...)` call and `return 1` path stay as the outer fallback (catch the raised exception
just outside the `with`, or restructure minimally — smallest change that lets the wrapper observe
failure without altering the script's own exit-code contract, which stays `0`/`1`).

- [ ] **Step 2: `create_user_pool_client.py`**

Wrap using `resource_id=USER_POOL_ID` (already read from env). Same shape: wrap the lookup/create
logic, preserve the existing `STATE_FILE` write and stdout contract untouched.

- [ ] **Step 3: `set_pre_token_trigger.py`**

Wrap using `resource_id=USER_POOL_ID` (already read from env), around the read-modify-`UpdateUserPool`
sequence.

- [ ] **Step 4: `wait_for_db.py`**

Wrap using `resource_id=f"{host}:{port}"` (it has no cluster/pool id available — the host:port
pair is the closest resource identity it has). This one is a healthcheck, not a mutation, but the
spec lists it among the four scripts to keep the traceability record complete for the whole
provisioning sequence — record `ok` on ready, `failed` on timeout, exactly matching its existing
exit codes 0/1 (exit code 2, "usage error," happens before the DB target is known and stays
outside the wrapper).

- [ ] **Step 5: Pass `EXECUTION_LOG_TABLE` to each provisioner**

Each script currently receives its env vars from the calling `terraform_data` `local-exec` block
(`USER_POOL_ID`, `ENDPOINT_URL`, etc.) or the Makefile recipe. Add `EXECUTION_LOG_TABLE` to each
of the three `local-exec` provisioner env blocks (`modules/cognito/main.tf` for the two Cognito
scripts, the phase-1 `terraform_data` for `create_mysql_database.py`) and to the Makefile recipe
that invokes `wait_for_db.py` if it's Makefile-invoked, OR to the `terraform_data` block that
invokes it in `environments/local/post/gate.tf` — check which. Value: the `execution_log_table_name`
output from `environments/local/backend`, threaded the same way `AWS_ENDPOINT_URL` already is
(read it via `terraform_remote_state` against the backend root's state, or pass it as a `-var`
from the Makefile using the same discovery shape as `DISCOVER_DB_PORT`; pick whichever the calling
root already does for other backend outputs — check `environments/local/data.tf` or equivalent for
precedent before choosing).

- [ ] **Step 6: Validate each script still runs standalone**

```bash
.venv/bin/python -c "import ast; ast.parse(open('infra/environments/local/scripts/create_mysql_database.py').read())"
.venv/bin/python -c "import ast; ast.parse(open('infra/modules/cognito/scripts/create_user_pool_client.py').read())"
.venv/bin/python -c "import ast; ast.parse(open('infra/modules/cognito/scripts/set_pre_token_trigger.py').read())"
.venv/bin/python -c "import ast; ast.parse(open('infra/environments/local/post/scripts/wait_for_db.py').read())"
cd infra/environments/local && terraform validate
cd post && terraform validate
cd ../../../modules/cognito && terraform init -backend=false >/dev/null && terraform validate
```

Expected: all parse and validate cleanly. (A live `make bootstrap` exercising these scripts end to
end happens in Task 6, after the Makefile split, so both changes are verified together rather than
twice.)

- [ ] **Step 7: Commit**

```bash
git add infra/environments/local/scripts/create_mysql_database.py \
        infra/modules/cognito/scripts/create_user_pool_client.py \
        infra/modules/cognito/scripts/set_pre_token_trigger.py \
        infra/environments/local/post/scripts/wait_for_db.py \
        infra/environments/local/scripts/../../../modules/cognito/main.tf \
        infra/environments/local/post/gate.tf
git commit -m "feat(infra): wire the four provisioning scripts to record_execution"
```

---

## Task 5: Move the phase-2 GRANTs out of `create_mysql_database.py`

**Files:**
- Modify: `infra/environments/local/scripts/create_mysql_database.py` (remove the two
  provider-enablement GRANTs)
- Create: `infra/environments/local/post/scripts/grant_mysql_provider_privileges.py`
- Modify: `infra/environments/local/post/*.tf` (invoke the new script as the first `local-exec`
  step of phase 2, before the `mysql` provider block's resources are created)

**Interfaces:**
- Consumes: the same root/test MySQL credentials `create_mysql_database.py` already uses, the
  discovered MySQL proxy port (already available to phase 2 via `infra-up-post`'s `-var mysql_port`).
- Produces: `test`'s `CREATE USER` + `SELECT ON mysql.*` grants, applied once, idempotently, before
  the `mysql` provider in `providers.tf` is asked to do anything.

- [ ] **Step 1: Remove the two GRANTs from `create_mysql_database.py`**

In `_sql()`, delete:

```sql
GRANT CREATE USER ON *.* TO 'test'@'%';
GRANT SELECT ON mysql.* TO 'test'@'%';
```

and their explanatory comment block (it now belongs with the new script). **Keep**
`GRANT ALL PRIVILEGES ON `tracking`.* TO 'test'@'%' WITH GRANT OPTION;` — that one is genuinely
about the database this script creates, not a phase-2 concern.

- [ ] **Step 2: Write the new script**

Create `infra/environments/local/post/scripts/grant_mysql_provider_privileges.py`, modeled
directly on `create_mysql_database.py`'s connection shape (same throwaway `mysql:8` container,
same root/`test` identities, same `discover_port("mysql")` call) but issuing only:

```sql
GRANT CREATE USER ON *.* TO 'test'@'%';
GRANT SELECT ON mysql.* TO 'test'@'%';
FLUSH PRIVILEGES;
```

Docstring explains why phase 2 needs this before its `mysql` provider block runs (verbatim
reasoning from the design: without these, `infra-up-post` fails 1227 then 1142) and that it is a
pure relocation from `create_mysql_database.py`, not new behavior. Wrap the body in
`record_execution(script="grant_mysql_provider_privileges.py", resource_id=<mysql cluster id>)`
per Task 2/4's pattern, directly at authoring time (no separate wiring step needed since this
script is new).

- [ ] **Step 3: Invoke it as phase 2's first step**

Add a `terraform_data` + `local-exec` resource in `infra/environments/local/post/` (a new
`grants.tf`, following the existing `gate.tf` shape) that runs
`grant_mysql_provider_privileges.py` via `var.python_bin`, and make the `mysql` provider's
consuming resources (the MySQL branch of `modules/db-app-user`, instantiated from
`environments/local/post/main.tf`) `depends_on` it — same `depends_on` pattern
`terraform_data.wait_for_db` already uses for the app-user modules. Order within phase 2 becomes:
GRANTs → wait-for-db gate → app-user modules (or GRANTs and the gate in parallel, both gating the
app-user modules — either is correct since they're independent; prefer parallel if `wait_for_db`
doesn't itself need the GRANTs, which it doesn't, since it only pings the port).

- [ ] **Step 4: Validate**

```bash
cd infra/environments/local && terraform validate
cd post && terraform validate
```

Expected: both `Success! The configuration is valid.`

- [ ] **Step 5: Live verification — GRANTs removed from phase 1 do not break it, and phase 2 supplies them**

```bash
make infra-down 2>/dev/null; make clean  # confirm prompted, answer per local convention
make bootstrap   # phase 1 only, after Task 6's split — see Task 6 before running this
```

If Task 6 (the Makefile split) isn't done yet, run this verification step AFTER Task 6 instead —
note it here but actually execute it as part of Task 6's Step 4 to avoid running the full chain
twice. (Leave this step checked off only once confirmed together with Task 6.)

- [ ] **Step 6: Commit**

```bash
git add infra/environments/local/scripts/create_mysql_database.py \
        infra/environments/local/post/scripts/grant_mysql_provider_privileges.py \
        infra/environments/local/post/grants.tf \
        infra/environments/local/post/main.tf
git commit -m "fix(infra): move phase-2 MySQL provider GRANTs out of create_mysql_database.py"
```

---

## Task 6: Split `make bootstrap` into `bootstrap` + `post-infra`

**Files:**
- Modify: `Makefile`
- Modify: `infra/environments/local/post/README.md`
- Modify: `infra/CLAUDE.md`

**Interfaces:**
- Produces: `make bootstrap` ending after `tracking` comes up (no `infra-up-post` call); a new
  `make post-infra` target (renamed from `infra-up-post`, or kept as an alias — pick ONE canonical
  name and update the help text) that runs the GRANTs step (Task 5) then the existing phase-2
  apply.

> **This task requires a live Floci run.** Docker + Floci available. This is also where Task 5's
> Step 5 live verification actually happens, run once as part of this task's Step 3 below.

- [ ] **Step 1: Remove the phase-2 call from `bootstrap`**

In the `Makefile`'s `bootstrap` target, delete the `$(MAKE) infra-up-post` line and its preceding
comment block. `bootstrap` now ends with `$(COMPOSE) up -d --build tracking`, unchanged apart from
that removal.

- [ ] **Step 2: Rename/expose `post-infra`**

Rename the `infra-up-post` target to `post-infra` (update `.PHONY`, the target name, and its
`##` help comment to: `## Harden a bootstrapped environment: MySQL provider grants + least-privilege DB app-users (phase 2)`).
Keep the target body as-is except for the new GRANTs step added in Task 5 (already wired via
Terraform, so the Makefile recipe itself may not need to change beyond the rename — confirm Task
5's `grants.tf` makes this automatic via the existing `terraform apply` call, rather than needing
a second explicit script invocation in the Makefile recipe).

Add a guard comment above the recipe:

```make
post-infra: scripts-setup ## Harden a bootstrapped environment: MySQL provider grants + least-privilege DB app-users (phase 2)
	@# REQUIRES a successful `make bootstrap` first — phase 2 reads phase-1's
	@# state via terraform_remote_state; running this against a torn-down or
	@# never-applied phase 1 fails at that read, before any provisioner runs.
	@# See docs/superpowers/specs/2026-07-30-post-infra-root-design.md
	@# ("What happens if post-infra runs before bootstrap").
	...
```

- [ ] **Step 3: Full end-to-end run**

```bash
make clean   # answer the ./data prompt per local convention
make bootstrap
```

Expected: all three services (`users`, `orders`, `tracking`) come up, Orders' seed data present,
**no** phase-2 apply runs. Confirm:

```bash
docker compose ps
curl -sf http://localhost:4566 >/dev/null && echo "floci up"
```

Then:

```bash
make post-infra
```

Expected: the GRANTs step runs first (visible in output), then the existing phase-2 apply creates
`users_app`, `orders_app`, `tracking_app` with no drift on a second `plan`:

```bash
cd infra/environments/local/post && terraform plan
```

Expected: `No changes.`

- [ ] **Step 4: Verify the before-bootstrap failure mode**

```bash
make clean   # tear down phase 1 entirely
make post-infra
```

Expected: fails at the `terraform_remote_state` read (no state file found / remote-state error),
**before** any `local-exec` provisioner runs — confirming the design's documented failure mode
needs no new code, only the guard comment/README text already added.

Then restore a working environment before moving on:

```bash
make bootstrap
make post-infra
```

- [ ] **Step 5: Update `infra/environments/local/post/README.md`**

Add a section (or amend the existing "What it reads" section) stating: `post-infra` requires a
prior successful `bootstrap`; its first Terraform-triggered step now grants `test` the MySQL
`CREATE USER`/`SELECT ON mysql.*` privileges (moved here from `create_mysql_database.py`, per
[[2026-07-30-post-infra-root-design]]); every provisioning script here writes an execution record
to the DynamoDB table exposed as `execution_log_table_name` — for traceability, never to skip a
re-run.

- [ ] **Step 6: Update `infra/CLAUDE.md`**

Update the "Two-phase apply — phase 2" subsection: `make bootstrap` no longer calls phase 2;
`make post-infra` is the explicit, separate hardening step, and it must run after a successful
`bootstrap`. Update the documented `make bootstrap` order to end at `tracking` (drop the
`infra-up-post` line from that sequence description). Add a one-line mention of the execution-log
table and where it's declared (`modules/tf-backend`), pointing at [[two-phase-terraform-apply]]
for the full argument.

- [ ] **Step 7: Commit**

```bash
git add Makefile infra/environments/local/post/README.md infra/CLAUDE.md
git commit -m "feat(infra): split make bootstrap from make post-infra"
```

---

## Task 7: Propagate into the vault

**Files:**
- Modify: `docs/infrastructure/decisions/two-phase-terraform-apply.md` (add an update section
  documenting the split, the moved GRANTs, and the execution log — mirroring the existing
  "Update 2026-07-30" pattern already in that note)
- Modify: `docs/shared/conventions/env-files.md` (note, if applicable, that
  `execution_log_table_name` is now among the values `.env.local.infra` carries — only if Task 4
  Step 5 actually threads it through the env-file generator rather than a direct
  `terraform_remote_state` read; adjust based on what Task 4 actually did)
- This step is normally owned by the `obsidian-vault` agent, not the implementer — record here
  only as the expected propagation targets so nothing is dropped; the actual vault edit happens
  through that agent's normal flow.

- [ ] **Step 1: Confirm both `propagates-to:` targets got real edits**

Once Tasks 1-6 land, verify `docs/infrastructure/decisions/two-phase-terraform-apply.md` and
`docs/shared/conventions/env-files.md` (if touched) have their `updated:` field bumped to the
propagation date and a new subsection/paragraph reflecting this plan's changes — per
[[doc-propagation]]. This task is a checklist, not new prose to draft here.

---

## Self-review — spec coverage

- Split `bootstrap`/`post-infra` (spec decision 1) → Task 6. ✓
- Move the GRANTs (spec decision 2) → Task 5. ✓
- DynamoDB execution log: table location, key shape, record contents, wrapper shape, failure
  semantics (spec decision 3) → Tasks 1, 2, 4. ✓
- Table name emitted via env file generator / discoverable by consumers → Task 1 Step 4, Task 4
  Step 5. ✓
- Seeds stay in bootstrap (spec decision 4) → no task touches `SEED_ON_STARTUP`; confirmed
  unchanged by Task 6 Step 1's diff being a pure removal of the `infra-up-post` line. ✓
- `post-infra` before `bootstrap` fails clearly → Task 6 Step 4. ✓
- Testing: success/failure/DynamoDB-unreachable for the wrapper → Task 3. ✓
- Out-of-scope runtime URL split → touched by no task (Global Constraints states it explicitly). ✓

## Related

- [[2026-07-30-post-infra-root-design]]
- [[two-phase-terraform-apply]]
- [[scripting-language]]
- [[env-files]]
- [[2026-07-15-two-phase-post-effects-design]]
- [[testing]]
