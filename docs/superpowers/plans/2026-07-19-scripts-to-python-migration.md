---
title: Scripts-to-Python Migration Plan
type: plan
area: infra
status: draft
created: 2026-07-19
updated: 2026-07-19
tags:
  - type/plan
  - area/infra
  - status/draft
related:
  - "[[2026-07-19-scripts-to-python-migration-design]]"
  - "[[2026-07-15-two-phase-post-effects-design]]"
  - "[[testing]]"
  - "[[git-workflow]]"
---

# Scripts-to-Python Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the repo's 5 remaining bash scripts with Python equivalents backed by a shared `lib3mrai` package, and record a durable Python-first scripting-language convention.

**Architecture:** A new installable package at `infra/scripts/` (`lib3mrai`) holds the logic the current `.sh` files duplicate — boto3 client construction honoring `AWS_ENDPOINT_URL`, colored console helpers, and DB port discovery / readiness polling. The five scripts stay colocated with the Terraform modules that invoke them; only their extension and interpreter change. Terraform `local-exec` blocks and the Makefile invoke the venv's interpreter by absolute path, never relying on `PATH`.

**Tech Stack:** Python 3 (`venv` + `pip`), boto3, Terraform `local-exec`, GNU Make, Docker CLI via `subprocess`.

## Global Constraints

- Every script's external interface is frozen: CLI args, stdout contract, exit codes, env var names, and state-file JSON shape must match the `.sh` version exactly. Terraform and the Makefile depend on them.
- `discover_db_port` prints **only** the port to stdout — no log lines, no color codes. The Makefile captures stdout via `$$(...)`.
- `wait_for_db` exit codes: `0` ready, `1` timeout, `2` unknown engine.
- Port discovery is **per-engine via the `Engine` field**. Floci assigns ports 7000–7099 by cluster creation order; postgres is NOT reliably on a fixed port. Never hardcode.
- All scripts remain idempotent — safe to re-run after every `terraform apply`.
- No secrets in logs or stdout.
- Bash is only acceptable with a limitation documented in the script itself (this is the convention being introduced).
- Python target: the interpreter created by `python3 -m venv`, invoked by absolute path (`.venv/bin/python`).

---

### Task 1: Shared package scaffold (`lib3mrai`)

**Files:**
- Create: `infra/scripts/pyproject.toml`
- Create: `infra/scripts/requirements.txt`
- Create: `infra/scripts/lib3mrai/__init__.py`
- Create: `infra/scripts/lib3mrai/console.py`
- Create: `infra/scripts/lib3mrai/aws.py`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `lib3mrai.console.ok(msg: str) -> None`, `no(msg: str) -> None`, `inf(msg: str) -> None` — write to stdout with the same green `OK:` / red `NO:` / plain-indent formatting the `.sh` files use.
  - `lib3mrai.aws.client(service: str) -> botocore.client.BaseClient` — boto3 client honoring `AWS_ENDPOINT_URL`, `AWS_DEFAULT_REGION`/`AWS_REGION`, and the `test`/`test` credential defaults, matching what `discover-db-port.sh` exports today.

- [ ] **Step 1: Create the package metadata**

`infra/scripts/pyproject.toml`:

```toml
[project]
name = "lib3mrai"
version = "0.1.0"
description = "Shared helpers for 3MRAI infrastructure scripts"
requires-python = ">=3.11"
dependencies = ["boto3>=1.34,<2"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["lib3mrai*"]
```

`infra/scripts/requirements.txt`:

```
-e .
```

- [ ] **Step 2: Write the console helpers**

`infra/scripts/lib3mrai/__init__.py` — empty file.

`infra/scripts/lib3mrai/console.py`:

```python
"""Colored console output matching the formatting the bash scripts used.

Kept byte-compatible on purpose: these scripts are read in terminal output
during `make bootstrap`, and changing the shape would make diffing a failed
run against a known-good one harder.
"""

import sys

GREEN = "\033[0;32m"
RED = "\033[0;31m"
RESET = "\033[0m"


def ok(msg: str) -> None:
    print(f"  {GREEN}OK{RESET}: {msg}")


def no(msg: str) -> None:
    print(f"  {RED}NO{RESET}: {msg}", file=sys.stderr)


def inf(msg: str) -> None:
    print(f"  {msg}")
```

- [ ] **Step 3: Write the boto3 client factory**

`infra/scripts/lib3mrai/aws.py`:

```python
"""boto3 client factory pointed at Floci (or real AWS) via the environment.

Mirrors the defaulting the bash scripts did with exported AWS_* vars, so a
script works standalone as well as when the Makefile has already exported them.
An empty AWS_ENDPOINT_URL means "use normal AWS endpoint resolution".
"""

import os

import boto3

DEFAULT_ENDPOINT = "http://localhost:4566"


def endpoint_url() -> str | None:
    """The endpoint override, or None to let boto3 resolve real AWS."""
    value = os.environ.get("AWS_ENDPOINT_URL", DEFAULT_ENDPOINT)
    return value or None


def client(service: str):
    """A boto3 client for `service`, honoring the Floci endpoint + test creds."""
    return boto3.client(
        service,
        endpoint_url=endpoint_url(),
        region_name=os.environ.get(
            "AWS_DEFAULT_REGION", os.environ.get("AWS_REGION", "us-east-1")
        ),
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID", "test"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY", "test"),
    )
```

- [ ] **Step 4: Ignore Python build artifacts**

Append to `.gitignore`:

```
# Python (infra scripts)
.venv/
__pycache__/
*.egg-info/
```

- [ ] **Step 5: Verify the package installs and imports**

Run:

```bash
python3 -m venv .venv && .venv/bin/pip install -q -e infra/scripts && \
  .venv/bin/python -c "from lib3mrai import aws, console; console.ok('lib3mrai importable'); print(aws.endpoint_url())"
```

Expected: prints a green `OK: lib3mrai importable` followed by `http://localhost:4566`.

- [ ] **Step 6: Commit**

```bash
git add infra/scripts .gitignore
git commit -m "feat(infra): add lib3mrai shared package for Python infra scripts"
```

---

### Task 2: `make scripts-setup` and the venv interpreter variable

**Files:**
- Modify: `Makefile` (variables block near line 5; new target; `.PHONY` line 27)

**Interfaces:**
- Consumes: `infra/scripts/` package from Task 1.
- Produces:
  - `PY` Make variable — absolute path to `.venv/bin/python`, used by every later Makefile change.
  - `make scripts-setup` — idempotent target creating `.venv/` and installing the package.

- [ ] **Step 1: Add the interpreter variables**

In `Makefile`, after the `ENV_FILE := .env` line, add:

```make
# Python interpreter for infra scripts. Absolute path on purpose: Terraform
# local-exec and this Makefile must never depend on whichever `python3` happens
# to be on PATH (a developer's shell may already sit inside an unrelated venv).
REPO_ROOT := $(shell pwd)
VENV      := $(REPO_ROOT)/.venv
PY        := $(VENV)/bin/python
```

- [ ] **Step 2: Point the discovery variable at the Python script**

Replace the `DISCOVER_DB_PORT := $(TF_LOCAL_DIR)/scripts/discover-db-port.sh` line with:

```make
DISCOVER_DB_PORT := $(TF_LOCAL_DIR)/scripts/discover_db_port.py
```

Leave the explanatory comment above it intact, but change its final sentence from `Also used by bootstrap.sh.` to `Also imported by bootstrap.py.`

- [ ] **Step 3: Add the setup target**

Add before the `## --- Docker Compose ---` section:

```make
## --- Python infra scripts ---

scripts-setup: $(VENV)/bin/python ## Create .venv and install the infra script package (idempotent)

$(VENV)/bin/python:
	@# Terraform local-exec and the Makefile call this interpreter by absolute
	@# path, so a missing venv surfaces here rather than as a cryptic
	@# "python: not found" from inside an apply.
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -q --upgrade pip
	$(VENV)/bin/pip install -q -e infra/scripts
	@echo "infra script venv ready at $(VENV)"
```

Add `scripts-setup` to the `.PHONY` list.

- [ ] **Step 4: Make apply-triggering targets depend on it**

Change the `infra-up`, `infra-up-post`, and `bootstrap` target lines to declare the dependency, e.g.:

```make
infra-up: scripts-setup ## Apply the local Terraform stack against Floci
```

```make
infra-up-post: scripts-setup ## Apply the phase-2 post-effects stack
```

```make
bootstrap: scripts-setup ## Bring the whole local chain up from scratch, in dependency order
```

Keep each target's existing recipe and `##` help text unchanged apart from the added prerequisite.

- [ ] **Step 5: Verify idempotence**

Run:

```bash
make scripts-setup && make scripts-setup
```

Expected: the first run creates the venv and prints `infra script venv ready at ...`; the second prints nothing new for the venv rule (Make sees the target file exists) and exits 0.

- [ ] **Step 6: Commit**

```bash
git add Makefile
git commit -m "build(infra): add make scripts-setup and venv interpreter variables"
```

---

### Task 3: `discover_db_port.py`

**Files:**
- Create: `infra/environments/local/scripts/discover_db_port.py`
- Create: `infra/scripts/lib3mrai/db.py`
- Delete: `infra/environments/local/scripts/discover-db-port.sh`

**Interfaces:**
- Consumes: `lib3mrai.aws.client` (Task 1).
- Produces:
  - `lib3mrai.db.discover_port(engine: str) -> int` — raises `LookupError` when no cluster matches the engine. Imported by `bootstrap.py` (Task 5).
  - `discover_db_port.py <engine>` CLI — prints the port to stdout, exit 0; exit 1 + stderr message when not found; exit 2 on a missing argument.

- [ ] **Step 1: Write the discovery helper**

`infra/scripts/lib3mrai/db.py`:

```python
"""Database discovery and readiness helpers for the local Floci stack."""

import subprocess
import time

from . import aws

COMPOSE_NETWORK = "3mrai_3mrai-network"


def discover_port(engine: str) -> int:
    """Return the RDS-proxy port Floci assigned to `engine`'s cluster.

    Floci assigns ports (7000-7099) by cluster CREATION ORDER, which is not
    stable across applies: postgres and mysql can swap between runs. So the
    port is resolved from the Engine field rather than assumed by position.
    """
    clusters = aws.client("rds").describe_db_clusters().get("DBClusters", [])
    for cluster in clusters:
        if cluster.get("Engine") == engine and cluster.get("Port"):
            return int(cluster["Port"])
    raise LookupError(
        f"no {engine} cluster/port found via describe-db-clusters "
        "(is Floci up and applied?)"
    )
```

- [ ] **Step 2: Write the CLI wrapper**

`infra/environments/local/scripts/discover_db_port.py`:

```python
#!/usr/bin/env python3
"""Discover the RDS-proxy port Floci assigned to a cluster, BY ENGINE.

Usage: discover_db_port.py <engine:postgres|mysql>

Prints ONLY the port to stdout so callers can capture it (the Makefile does:
`pgport="$(... discover_db_port.py postgres)"`). Anything diagnostic goes to
stderr. Exits 1 if the engine's cluster/port is not found, 2 on a usage error.

The single reusable discovery mechanism: the Makefile calls it as a CLI and
bootstrap.py imports lib3mrai.db.discover_port directly (DRY).
"""

import sys

from lib3mrai.db import discover_port


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("discover_db_port.py: missing engine argument (postgres|mysql)", file=sys.stderr)
        return 2
    try:
        print(discover_port(argv[1]))
    except LookupError as exc:
        print(f"discover_db_port.py: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

- [ ] **Step 3: Verify against a running Floci**

Run (with the stack up and applied):

```bash
.venv/bin/python infra/environments/local/scripts/discover_db_port.py postgres
```

Expected: a bare port number on stdout (e.g. `7001` or `7002`), exit 0. Compare against the old script's output before deleting it:

```bash
bash infra/environments/local/scripts/discover-db-port.sh postgres
```

Both must print the same number.

- [ ] **Step 4: Verify the failure paths**

Run:

```bash
.venv/bin/python infra/environments/local/scripts/discover_db_port.py; echo "exit=$?"
.venv/bin/python infra/environments/local/scripts/discover_db_port.py oracle; echo "exit=$?"
```

Expected: first prints the usage message to stderr with `exit=2`; second prints the not-found message with `exit=1`.

- [ ] **Step 5: Delete the bash version and commit**

```bash
git rm infra/environments/local/scripts/discover-db-port.sh
git add infra/scripts/lib3mrai/db.py infra/environments/local/scripts/discover_db_port.py
git commit -m "refactor(infra): port discover-db-port to Python with boto3"
```

---

### Task 4: `wait_for_db.py` and its Terraform call site

**Files:**
- Create: `infra/environments/local/post/scripts/wait_for_db.py`
- Modify: `infra/scripts/lib3mrai/db.py` (add `wait_for_db`)
- Modify: `infra/environments/local/post/gate.tf:19-22`
- Delete: `infra/environments/local/post/scripts/wait-for-db.sh`

**Interfaces:**
- Consumes: `lib3mrai.db` (Task 3).
- Produces: `lib3mrai.db.wait_for_db(host: str, port: int, engine: str, attempts: int, sleep_s: int) -> bool` — True once the DB accepts connections, False on timeout.

**Note on this call site:** `gate.tf` differs from the two Cognito ones — it puts `bash <abspath>` inside `command` *and* sets `interpreter` to `["/usr/bin/env", "bash", "-c"]`. Both halves change here.

- [ ] **Step 1: Add the readiness helper**

Append to `infra/scripts/lib3mrai/db.py`:

```python
PROBES = {
    "postgres": lambda host, port: [
        "docker", "run", "--rm", "--network", COMPOSE_NETWORK,
        "postgres:14.6-alpine",
        "pg_isready", "-h", host, "-p", str(port),
    ],
    "mysql": lambda host, port: [
        "docker", "run", "--rm", "--network", COMPOSE_NETWORK,
        "mysql:8",
        "mysqladmin", "ping", "--ssl-mode=DISABLED",
        "-h", host, "-P", str(port), "--silent",
    ],
}


def wait_for_db(host: str, port: int, engine: str, attempts: int = 30, sleep_s: int = 2) -> bool:
    """Poll until `engine` at host:port accepts connections.

    The probe runs INSIDE a throwaway container joined to Floci's compose
    network, so it resolves the `floci` service by name — the same network the
    app containers use. Returns False if it never became ready.
    """
    if engine not in PROBES:
        raise ValueError(f"unknown engine: {engine}")
    build_cmd = PROBES[engine]
    for attempt in range(1, attempts + 1):
        result = subprocess.run(
            build_cmd(host, port), capture_output=True, text=True
        )
        if result.returncode == 0:
            return True
        print(f"waiting for {engine} at {host}:{port} ({attempt}/{attempts})…")
        time.sleep(sleep_s)
    return False
```

- [ ] **Step 2: Write the CLI wrapper**

`infra/environments/local/post/scripts/wait_for_db.py`:

```python
#!/usr/bin/env python3
"""Poll a DB endpoint until it accepts connections, or fail after a timeout.

Usage: wait_for_db.py <host> <port> <engine:postgres|mysql>

Exit codes (unchanged from the bash version — gate.tf depends on them):
  0 ready, 1 timeout, 2 unknown engine or usage error.

Overridable via env: WAIT_ATTEMPTS (default 30), WAIT_SLEEP (default 2).
"""

import os
import sys

from lib3mrai.db import wait_for_db


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print("wait_for_db.py: usage: wait_for_db.py <host> <port> <engine>", file=sys.stderr)
        return 2
    host, port, engine = argv[1], int(argv[2]), argv[3]
    attempts = int(os.environ.get("WAIT_ATTEMPTS", "30"))
    sleep_s = int(os.environ.get("WAIT_SLEEP", "2"))
    try:
        ready = wait_for_db(host, port, engine, attempts, sleep_s)
    except ValueError as exc:
        print(f"wait_for_db.py: {exc}", file=sys.stderr)
        return 2
    if ready:
        print(f"{engine} at {host}:{port} ready")
        return 0
    print(f"timed out waiting for {engine} at {host}:{port}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

- [ ] **Step 3: Rewire the Terraform gate**

In `infra/environments/local/post/gate.tf`, replace the `provisioner "local-exec"` block with:

```hcl
  # abspath so the script resolves regardless of the local-exec working dir.
  # The venv interpreter is called by ABSOLUTE PATH — never `python3` off PATH,
  # which may resolve into an unrelated venv on a developer machine. `make
  # scripts-setup` (a prerequisite of the apply targets) guarantees it exists.
  provisioner "local-exec" {
    command     = "${abspath("${path.root}/../../../.venv/bin/python")} ${abspath("${path.module}/scripts/wait_for_db.py")} ${self.input.host} ${self.input.port} ${self.input.engine}"
    interpreter = ["/usr/bin/env", "bash", "-c"]
  }
```

Update the comment above the resource that says `bash invoked explicitly on the absolute path` to reflect the Python interpreter.

- [ ] **Step 4: Verify the path resolves**

`gate.tf` lives in `infra/environments/local/post/`, so `path.root` for that stack is that directory and `../../../` reaches the repo root. Confirm before applying:

```bash
ls -l infra/environments/local/post/../../../.venv/bin/python
```

Expected: the file exists (a symlink or binary). If the relative depth is wrong, fix it here rather than at apply time.

- [ ] **Step 5: Verify end to end**

Run:

```bash
.venv/bin/python infra/environments/local/post/scripts/wait_for_db.py floci "$(.venv/bin/python infra/environments/local/scripts/discover_db_port.py postgres)" postgres; echo "exit=$?"
```

Expected: `postgres at floci:<port> ready` and `exit=0` with the stack up.

Then run the real apply path:

```bash
make infra-up-post
```

Expected: applies cleanly, with the wait gate printing the ready line.

- [ ] **Step 6: Delete the bash version and commit**

```bash
git rm infra/environments/local/post/scripts/wait-for-db.sh
git add infra/scripts/lib3mrai/db.py infra/environments/local/post/scripts/wait_for_db.py infra/environments/local/post/gate.tf
git commit -m "refactor(infra): port wait-for-db to Python and rewire the post gate"
```

---

### Task 5: `bootstrap.py` (live nginx-alias step only)

**Files:**
- Create: `infra/environments/local/bootstrap.py`
- Modify: `Makefile` (the `bootstrap` recipe line invoking the script)
- Delete: `infra/environments/local/bootstrap.sh`

**Interfaces:**
- Consumes: `lib3mrai.console` (Task 1), `lib3mrai.db.discover_port` (Task 3, imported not shelled out).
- Produces: nothing later tasks consume.

**Scope note:** Only the nginx-stable alias step is ported. The `bootstrap_app_db_user` / `bootstrap_orders_app_db_user` functions are deleted — `bootstrap.sh`'s own comments record that the phase-2 post-effects apply replaced them, and their rationale lives in [[2026-07-15-two-phase-post-effects-design]]. Do not port them.

- [ ] **Step 1: Write the script**

`infra/environments/local/bootstrap.py`:

```python
#!/usr/bin/env python3
"""Attach a STABLE Docker-DNS alias to the nginx ECS container.

WHY: Floci launches the nginx ECS task as a Docker container whose name and IP
change on every `terraform apply` (the task is recreated). Instead of patching
the API Gateway integration URI with a volatile IP each run, we attach a
CONSTANT network alias (`nginx-stable`) to whichever nginx container is
running. The API GW's per-route integrations point at
http://nginx-stable/<route-path>, so they stay correct at apply time and
Terraform state never drifts.

Floci's Route53 is management-plane only (no resolution) and ECS tasks are not
registered in Cloud Map, so a Docker-native alias is the working approach —
Docker's embedded DNS at 127.0.0.11 resolves it, including from Floci's API GW
container.

Idempotent: safe to run repeatedly. Run once after each `terraform apply`.

Usage: .venv/bin/python infra/environments/local/bootstrap.py
"""

import os
import subprocess
import sys
import time

from lib3mrai.console import inf, no, ok

NETWORK = "3mrai_3mrai-network"
ALIAS = os.environ.get("NGINX_STABLE_ALIAS", "nginx-stable")
# Empty by default: attach the alias only and let Docker assign the IP. A stable
# NAME is all the integrations need; pinning an IP only adds a failure mode,
# because Floci recreates its network with a different subnet across runs
# (observed 192.168.155.0/24 -> 192.168.148.0/24) and a hardcoded address
# eventually falls outside it. Set NGINX_STABLE_IP=<addr> to opt back in.
FIXED_IP = os.environ.get("NGINX_STABLE_IP", "")


def docker(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, text=True)


def find_nginx_container(attempts: int = 20, sleep_s: int = 3) -> str | None:
    """The running nginx ECS container Floci launched, or None after retries."""
    for attempt in range(1, attempts + 1):
        names = docker("ps", "--format", "{{.Names}}").stdout.splitlines()
        for name in names:
            lowered = name.lower()
            if "floci-ecs" in lowered and "nginx" in lowered:
                return name
        inf(f"waiting for nginx ECS container (attempt {attempt}/{attempts})…")
        time.sleep(sleep_s)
    return None


def container_with_alias(alias: str) -> str | None:
    """The container currently answering to `alias` on the compose network."""
    names = docker(
        "ps", "--filter", f"network={NETWORK}", "--format", "{{.Names}}"
    ).stdout.split()
    for name in names:
        aliases = docker(
            "inspect", name,
            "--format",
            "{{range .NetworkSettings.Networks}}{{range .Aliases}}{{.}} {{end}}{{end}}",
        ).stdout.split()
        if alias in aliases:
            return name
    return None


def attach_alias(container: str) -> None:
    """(Re)attach the alias. Docker needs disconnect+connect to reset one."""
    inf(f"attaching alias '{ALIAS}'"
        + (f" and IP {FIXED_IP}" if FIXED_IP else "")
        + f" on {NETWORK} ...")
    docker("network", "disconnect", NETWORK, container)  # no-op-safe
    if FIXED_IP:
        result = docker(
            "network", "connect", "--alias", ALIAS, "--ip", FIXED_IP, NETWORK, container
        )
        if result.returncode == 0:
            return
        no(f"fixed IP {FIXED_IP} unavailable ({result.stderr.strip()}); retrying alias-only…")
    result = docker("network", "connect", "--alias", ALIAS, NETWORK, container)
    if result.returncode != 0:
        no(f"failed to attach alias: {result.stderr.strip()}")
        sys.exit(1)


def verify(container: str) -> bool:
    """The alias resolves and proxies to users /v1/health -> {"status":"ok"}."""
    body = docker(
        "exec", container, "sh", "-c",
        f"wget -qO- --timeout=5 http://{ALIAS}/v1/health 2>/dev/null",
    ).stdout
    return '"status":"ok"' in body


def main() -> int:
    print("== bootstrap: stable DNS alias for the nginx ECS container ==")

    nginx = find_nginx_container()
    if not nginx:
        no("no nginx ECS container found. Is Floci up and 'terraform apply' done?")
        return 1
    ok(f"nginx container: {nginx}")

    if container_with_alias(ALIAS) == nginx:
        ok(f"alias '{ALIAS}' already attached to the current nginx container — nothing to do.")
        return 0

    attach_alias(nginx)
    time.sleep(1)

    if not verify(nginx):
        no(f"alias attached but /v1/health did not return the expected body")
        inf("the users container may not be ready yet; re-run after it is up.")
        return 1

    ok(f"alias '{ALIAS}' resolves and proxies -> users /v1/health {{\"status\":\"ok\"}}")
    print()
    print(f"  API GW per-route integrations already target http://{ALIAS}/<path> — no patch needed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Rewire the Makefile invocation**

In the `bootstrap` recipe, replace:

```make
	bash $(TF_LOCAL_DIR)/bootstrap.sh
```

with:

```make
	$(PY) $(TF_LOCAL_DIR)/bootstrap.py
```

Also update the recipe's comment that reads `then bootstrap.sh (app DB user + nginx alias)` to `then bootstrap.py (nginx alias)`, since the app-DB-user step moved to the post-effects apply.

- [ ] **Step 3: Verify idempotence against a running stack**

Run twice:

```bash
.venv/bin/python infra/environments/local/bootstrap.py; echo "exit=$?"
.venv/bin/python infra/environments/local/bootstrap.py; echo "exit=$?"
```

Expected: the first attaches the alias and reports the `/v1/health` verification; the second reports `alias 'nginx-stable' already attached … nothing to do.` Both exit 0.

- [ ] **Step 4: Delete the bash version and commit**

```bash
git rm infra/environments/local/bootstrap.sh
git add infra/environments/local/bootstrap.py Makefile
git commit -m "refactor(infra): port bootstrap to Python, dropping superseded app-user steps"
```

---

### Task 6: `create_user_pool_client.py`

**Files:**
- Create: `infra/modules/cognito/scripts/create_user_pool_client.py`
- Modify: `infra/modules/cognito/main.tf:100-113` (the `client_via_cli` provisioner)
- Delete: `infra/modules/cognito/scripts/create-user-pool-client.sh`

**Interfaces:**
- Consumes: `lib3mrai.aws.client` (Task 1).
- Produces: writes `{"ClientId": "...", "UserPoolId": "..."}` to `STATE_FILE` — the shape `data.local_file.client_via_cli` reads back into `output.client_id`. Must not change.

- [ ] **Step 1: Write the script**

`infra/modules/cognito/scripts/create_user_pool_client.py`:

```python
#!/usr/bin/env python3
"""Idempotent Cognito App Client creation via boto3.

Used ONLY by modules/cognito/main.tf's terraform_data.client_via_cli, gated by
var.manage_client_via_provider = false (Floci local only — see that variable's
description for why the native aws_cognito_user_pool_client resource cannot be
used against Floci).

Idempotent: if a client named CLIENT_NAME already exists under USER_POOL_ID it
is reused (its id written to STATE_FILE) rather than creating a duplicate on
every re-apply.

Required env vars (set by the calling local-exec provisioner):
  USER_POOL_ID  - Cognito User Pool id the client belongs to
  CLIENT_NAME   - name of the App Client (used for idempotent lookup)
  STATE_FILE    - path to write the resulting {"ClientId": ...} JSON
  ENDPOINT_URL  - optional endpoint override (empty = default resolution)
  AWS_REGION    - AWS region
"""

import json
import os
import pathlib
import sys

from lib3mrai import aws

# The provisioner passes the endpoint as ENDPOINT_URL; lib3mrai.aws reads
# AWS_ENDPOINT_URL. Bridge them before building the client, preserving the
# "empty means default resolution" contract.
if "ENDPOINT_URL" in os.environ:
    os.environ["AWS_ENDPOINT_URL"] = os.environ["ENDPOINT_URL"]


def require(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        print(f"create_user_pool_client.py: {name} is required", file=sys.stderr)
        sys.exit(1)
    return value


def main() -> int:
    pool_id = require("USER_POOL_ID")
    client_name = require("CLIENT_NAME")
    state_file = pathlib.Path(require("STATE_FILE"))
    idp = aws.client("cognito-idp")

    state_file.parent.mkdir(parents=True, exist_ok=True)

    # 1. Idempotent lookup: reuse an existing client with the same name.
    existing = idp.list_user_pool_clients(UserPoolId=pool_id, MaxResults=60)
    for candidate in existing.get("UserPoolClients", []):
        if candidate.get("ClientName") == client_name:
            client_id = candidate["ClientId"]
            state_file.write_text(
                json.dumps({"ClientId": client_id, "UserPoolId": pool_id})
            )
            print(f"create_user_pool_client.py: reused existing client '{client_name}' ({client_id})")
            return 0

    # 2. Create it. Auth flows must match what the native resource sets
    #    (modules/cognito/main.tf, aws_cognito_user_pool_client.this).
    created = idp.create_user_pool_client(
        UserPoolId=pool_id,
        ClientName=client_name,
        GenerateSecret=False,
        ExplicitAuthFlows=[
            "ALLOW_ADMIN_USER_PASSWORD_AUTH",
            "ALLOW_USER_PASSWORD_AUTH",
            "ALLOW_REFRESH_TOKEN_AUTH",
        ],
    )
    client_id = created["UserPoolClient"]["ClientId"]
    state_file.write_text(json.dumps({"ClientId": client_id, "UserPoolId": pool_id}))
    print(f"create_user_pool_client.py: created client '{client_name}' ({client_id})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Rewire the Terraform provisioner**

In `infra/modules/cognito/main.tf`, in `terraform_data.client_via_cli`, replace the `command` and `interpreter` lines with:

```hcl
    command     = "${abspath("${path.root}/../../../.venv/bin/python")} ${path.module}/scripts/create_user_pool_client.py"
    interpreter = ["/usr/bin/env", "bash", "-c"]
```

Keep the `environment` block exactly as it is — the script reads the same five variables.

Update the comment above the resource that references `scripts/create-user-pool-client.sh` to `scripts/create_user_pool_client.py`.

- [ ] **Step 3: Verify idempotence directly**

With the stack up:

```bash
USER_POOL_ID="$(cd infra/environments/local && terraform output -raw cognito_user_pool_id)" \
CLIENT_NAME="probe-client" \
STATE_FILE=/tmp/probe-client.json \
ENDPOINT_URL=http://localhost:4566 \
AWS_REGION=us-east-1 \
.venv/bin/python infra/modules/cognito/scripts/create_user_pool_client.py
```

Expected: first run prints `created client 'probe-client' (...)`; a second identical run prints `reused existing client 'probe-client' (...)` with the same id. `cat /tmp/probe-client.json` shows both `ClientId` and `UserPoolId`.

- [ ] **Step 4: Delete the bash version and commit**

```bash
git rm infra/modules/cognito/scripts/create-user-pool-client.sh
git add infra/modules/cognito/scripts/create_user_pool_client.py infra/modules/cognito/main.tf
git commit -m "refactor(infra): port create-user-pool-client to Python with boto3"
```

---

### Task 7: `set_pre_token_trigger.py`

**Files:**
- Create: `infra/modules/cognito/scripts/set_pre_token_trigger.py`
- Modify: `infra/modules/cognito/main.tf:172-183` (the `pre_token_trigger` provisioner)
- Delete: `infra/modules/cognito/scripts/set-pre-token-trigger.sh`

**Interfaces:**
- Consumes: `lib3mrai.aws.client` (Task 1).
- Produces: nothing later tasks consume.

**Why this one gains most:** the bash version is a wrapper around a `python3 <<'PY'` heredoc that itself shells out to `aws` via `subprocess`. Three layers collapse into one Python file with boto3.

**Critical behavior to preserve:** `UpdateUserPool` is a PUT, not a PATCH. Passing only `--lambda-config` resets every other top-level pool setting to service defaults — silently re-tightening the intentionally relaxed local password policy. The script must read the current pool, keep the fields `UpdateUserPool` accepts, inject the V2 `LambdaConfig`, and re-apply the whole thing. `Schema`/custom attributes are create-only and must NOT be re-passed, so `custom:app_user_id` stays safe.

- [ ] **Step 1: Write the script**

`infra/modules/cognito/scripts/set_pre_token_trigger.py`:

```python
#!/usr/bin/env python3
"""Idempotent Cognito Pre-Token-Generation V2 trigger wiring via boto3.

Used ONLY by modules/cognito/main.tf's terraform_data.pre_token_trigger, a
Floci-only workaround: the AWS provider is pinned to 5.31.0 (ADR-0016), whose
aws_cognito_user_pool `lambda_config` block has no
`pre_token_generation_config` sub-block, so the V2 trigger cannot be declared
natively at that provider version. This registers it directly, outside
Terraform's resource lifecycle.

Idempotent: update_user_pool is declarative, so re-running with the same
USER_POOL_ID/LAMBDA_ARN yields the same pool state.

SETTINGS-PRESERVING: UpdateUserPool is a PUT, not a PATCH — a call passing only
LambdaConfig would reset every OTHER top-level pool setting (Policies,
AutoVerifiedAttributes, AdminCreateUserConfig, …) to service defaults, silently
re-tightening the intentionally relaxed local password policy. So this reads the
current pool, keeps the fields UpdateUserPool accepts, injects the V2
LambdaConfig, and re-applies the whole thing. (Schema/custom attributes are NOT
re-passable — create-only plus add-custom-attributes — and are deliberately not
touched, so custom:app_user_id is safe.)

Required env vars (set by the calling local-exec provisioner):
  USER_POOL_ID  - Cognito User Pool id to wire the trigger on
  LAMBDA_ARN    - ARN of the Pre-Token-Generation V2 Lambda
  ENDPOINT_URL  - optional endpoint override (empty = default resolution)
  AWS_REGION    - AWS region
"""

import os
import sys

from lib3mrai import aws

if "ENDPOINT_URL" in os.environ:
    os.environ["AWS_ENDPOINT_URL"] = os.environ["ENDPOINT_URL"]

# Fields describe_user_pool returns that update_user_pool also accepts. Schema is
# deliberately absent (create-only).
PRESERVED_FIELDS = [
    "Policies",
    "VerificationMessageTemplate",
    "UserAttributeUpdateSettings",
    "DeviceConfiguration",
    "EmailConfiguration",
    "SmsConfiguration",
    "UserPoolTags",
    "AdminCreateUserConfig",
    "UserPoolAddOns",
    "AccountRecoverySetting",
    "DeletionProtection",
    "MfaConfiguration",
    "SmsAuthenticationMessage",
    "AutoVerifiedAttributes",
]


def require(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        print(f"set_pre_token_trigger.py: {name} is required", file=sys.stderr)
        sys.exit(1)
    return value


def main() -> int:
    pool_id = require("USER_POOL_ID")
    lambda_arn = require("LAMBDA_ARN")
    idp = aws.client("cognito-idp")

    # 1. Read the current pool.
    pool = idp.describe_user_pool(UserPoolId=pool_id)["UserPool"]

    # 2. Preserve the existing LambdaConfig, add/override the Pre-Token V2 trigger.
    lambda_config = dict(pool.get("LambdaConfig", {}))
    lambda_config["PreTokenGenerationConfig"] = {
        "LambdaVersion": "V2_0",
        "LambdaArn": lambda_arn,
    }

    # 3. Re-apply: current settings preserved + trigger wired.
    params = {
        field: pool[field]
        for field in PRESERVED_FIELDS
        if pool.get(field) not in (None, "", {}, [])
    }
    idp.update_user_pool(UserPoolId=pool_id, LambdaConfig=lambda_config, **params)

    # 4. Verify the trigger landed (independent confirmation, not just no-raise).
    got = (
        idp.describe_user_pool(UserPoolId=pool_id)["UserPool"]
        .get("LambdaConfig", {})
        .get("PreTokenGenerationConfig", {})
        .get("LambdaArn", "")
    )
    if got != lambda_arn:
        print(
            f"set_pre_token_trigger.py: FAILED — trigger not wired (got '{got}', want '{lambda_arn}')",
            file=sys.stderr,
        )
        return 1

    print(
        f"set_pre_token_trigger.py: wired Pre-Token-Generation V2 trigger on "
        f"{pool_id} -> {lambda_arn} (existing pool settings preserved)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Rewire the Terraform provisioner**

In `infra/modules/cognito/main.tf`, in `terraform_data.pre_token_trigger`, replace the `command` and `interpreter` lines with:

```hcl
    command     = "${abspath("${path.root}/../../../.venv/bin/python")} ${path.module}/scripts/set_pre_token_trigger.py"
    interpreter = ["/usr/bin/env", "bash", "-c"]
```

Keep the `environment` block unchanged.

- [ ] **Step 3: Verify the password policy survives**

This is the regression the settings-preserving logic exists to prevent. Capture the policy, run the script, compare:

```bash
POOL="$(cd infra/environments/local && terraform output -raw cognito_user_pool_id)"
aws --endpoint-url http://localhost:4566 cognito-idp describe-user-pool --user-pool-id "$POOL" \
  --query 'UserPool.Policies' > /tmp/policy-before.json

USER_POOL_ID="$POOL" \
LAMBDA_ARN="$(aws --endpoint-url http://localhost:4566 lambda list-functions \
  --query 'Functions[?ends_with(FunctionName, `pretoken`)].FunctionArn | [0]' --output text)" \
ENDPOINT_URL=http://localhost:4566 AWS_REGION=us-east-1 \
.venv/bin/python infra/modules/cognito/scripts/set_pre_token_trigger.py

aws --endpoint-url http://localhost:4566 cognito-idp describe-user-pool --user-pool-id "$POOL" \
  --query 'UserPool.Policies' > /tmp/policy-after.json
diff /tmp/policy-before.json /tmp/policy-after.json && echo "policy preserved"
```

Expected: the script prints the `wired Pre-Token-Generation V2 trigger` line, and `diff` reports no differences followed by `policy preserved`.

- [ ] **Step 4: Delete the bash version and commit**

```bash
git rm infra/modules/cognito/scripts/set-pre-token-trigger.sh
git add infra/modules/cognito/scripts/set_pre_token_trigger.py infra/modules/cognito/main.tf
git commit -m "refactor(infra): port set-pre-token-trigger to Python with boto3"
```

---

### Task 8: The scripting-language convention

**Files:**
- Create: `docs/shared/conventions/scripting-language.md` (via the `obsidian-vault` agent — it is the sole writer of `docs/`)
- Modify: `CLAUDE.md` (root — a new subsection under Working rules)
- Modify: `infra/CLAUDE.md`
- Modify: `docs/shared/conventions/index.md` if one exists (the vault agent handles indexing)

**Interfaces:**
- Consumes: the decisions implemented in Tasks 1–7 as the worked example.
- Produces: the durable convention that outlives this milestone.

- [ ] **Step 1: Write the convention note**

Dispatch the `obsidian-vault` agent to create `docs/shared/conventions/scripting-language.md` with vault-standard frontmatter (`type: convention`, `area: shared`, `status: active`, folder-style tags, `## Related`). Content:

- **Decision tree, in order:**
  - **Python first** — infra scripting, Terraform pre/post effects, and anything touching AWS, JSON, or non-trivial control flow. Runs via the repo venv (`make scripts-setup`), invoked by absolute path (`.venv/bin/python`).
  - **JavaScript second** — when the task already lives in the Node ecosystem present in the repo (vault tooling, pnpm workspace, npm dependencies). The three `scripts/*.mjs` files are the standing example.
  - **Bash last** — only with an explicitly documented limitation, recorded in a comment in the script file itself.
- **Selection criteria:** flexibility, customization, readability, performance, long-term scalability.
- **Why:** two of the five migrated scripts were already Python inside a bash heredoc because bash could not parse JSON — the tell that the default was wrong.
- **Rules:** new scripts default to Python; shared logic goes in `lib3mrai` rather than being duplicated; scripts invoked by Terraform use the absolute venv interpreter path.
- Link to [[2026-07-19-scripts-to-python-migration-design]].

- [ ] **Step 2: Reference it from the root CLAUDE.md**

Add under **Working rules**, after the Node.js subsection:

```markdown
### Scripting language — Python first
- New scripts are written in **Python** by default (infra scripting, pre/post effects, anything touching AWS/JSON). **JavaScript** when the task lives in the Node ecosystem already present (vault tooling, pnpm workspace). **Bash** only with an explicitly documented limitation, recorded in the script itself.
- Infra Python scripts run from the repo venv: `make scripts-setup` creates it, and Terraform/Makefile invoke `.venv/bin/python` by **absolute path** (never `python3` off `PATH`).
- Shared helpers live in `infra/scripts/lib3mrai/` — don't duplicate boto3 client setup or console helpers.
- Full convention: `docs/shared/conventions/scripting-language.md` → [[scripting-language]].
```

- [ ] **Step 3: Reference it from infra/CLAUDE.md**

Add an equivalent short subsection pointing at the same convention note, noting that the five infra scripts are Python and that `local-exec` blocks call the venv interpreter by absolute path.

- [ ] **Step 4: Validate the vault**

Run:

```bash
nvm use && node scripts/validate-vault.mjs
```

Expected: `Vault validation passed: N notes OK` with no broken wikilinks. If `[[scripting-language]]` reports broken, the note's filename and `name`/title must match the wikilink.

- [ ] **Step 5: Commit**

```bash
git add docs/shared/conventions/scripting-language.md docs/ CLAUDE.md infra/CLAUDE.md
git commit -m "docs(vault): add Python-first scripting-language convention"
```

---

### Task 9: Full-cycle verification

**Files:**
- No source changes. This task is the acceptance gate from the spec.

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: the evidence that the migration is behavior-preserving.

- [ ] **Step 1: Confirm no `.sh` files remain**

Run:

```bash
find . -name "*.sh" -not -path "*/node_modules/*" -not -path "*/.git/*"
```

Expected: no output. If any remain, either migrate them or document the limitation per the new convention.

- [ ] **Step 2: Tear down**

Run:

```bash
make infra-down
```

Expected: completes without error.

- [ ] **Step 3: Full bring-up from scratch**

Run:

```bash
make bootstrap
```

Expected: the whole chain completes — Floci up, `scripts-setup` runs (creating the venv if absent), terraform init/apply, migrate, users container, `bootstrap.py` attaching the nginx alias with the `/v1/health` verification, `infra-up-post` passing its wait gate, orders container. No `python: not found`, no `ModuleNotFoundError`.

- [ ] **Step 4: Regenerate the env file**

Run:

```bash
make env-file && grep -E 'USERS_DB_PORT|ORDERS_DB_PORT' .env
```

Expected: both ports present and numeric — proof that `discover_db_port.py` fed the Makefile correctly through command substitution (this is the stdout-purity contract).

- [ ] **Step 5: Gateway E2E with a real Cognito JWT**

Run the repo's gateway E2E suite (per [[testing]], the layer that exercises the URL a user actually hits):

```bash
nvm use && pnpm -C e2e test
```

Expected: passes, matching the pre-migration result. This is the regression check that infra bring-up still produces a working stack — this milestone adds no endpoints, so no new test layers are required.

- [ ] **Step 6: Re-run bootstrap to confirm idempotence**

Run:

```bash
make bootstrap
```

Expected: completes again cleanly; `bootstrap.py` reports the alias is already attached, and the Cognito scripts report reuse rather than creation.

- [ ] **Step 7: Commit any fixes**

```bash
git add -A
git commit -m "test(infra): verify full local bring-up after the Python migration"
```

---

## Related

- [[2026-07-19-scripts-to-python-migration-design]]
- [[2026-07-15-two-phase-post-effects-design]]
- [[testing]]
- [[git-workflow]]
