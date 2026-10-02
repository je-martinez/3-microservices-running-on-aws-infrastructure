---
title: "Dev Stack on Floci 2.1.0 Implementation Plan"
type: plan
area: infra
status: draft
created: 2026-10-02
updated: 2026-10-02
tags:
  - type/plan
  - area/infra
  - status/draft
propagates-to:
  - "[[floci-recreate-destroys-backing-containers]]"
  - "[[floci-storage-modes-and-tmp-corruption]]"
  - "[[floci-vs-ministack-spike-findings]]"
  - "[[local-dev-floci]]"
related:
  - "[[2026-10-02-floci-preprod-environment-design]]"
  - "[[2026-10-02-floci-preprod-environment]]"
  - "[[floci-recreate-destroys-backing-containers]]"
  - "[[floci-storage-modes-and-tmp-corruption]]"
  - "[[floci-vs-ministack-spike-findings]]"
  - "[[local-dev-floci]]"
---

# Dev Stack on Floci 2.1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the local dev stack from Floci 1.7.0 to a pinned Floci 2.1.0 without regressing data persistence across Floci restarts.

**Architecture:** Floci 2.1.0's graceful shutdown deletes its DocumentDB and ElastiCache containers on every stop, so the `floci` compose service gets `stop_signal: SIGKILL`; a new `make heal` restarts exited backing containers, wakes the lazy ECS reconciler and removes orphan ECS task containers; `make doctor` tells "exited, healable" apart from "gone, rebuild". The image no longer ships `curl`, so the healthcheck moves to bash `/dev/tcp`.

**Tech Stack:** Docker Compose, Floci 2.1.0, Python 3.11 (`lib3mrai`, pytest), GNU Make, Terraform (AWS provider `= 5.31.0`).

**Spec:** `docs/superpowers/specs/2026-10-02-floci-preprod-environment-design.md` (phase F0)

## Global Constraints

- Floci image: `floci/floci:2.1.0` exactly — never `latest`.
- `FLOCI_STORAGE_MODE=persistent` stays (SIGKILL is only safe because it flushes on every write).
- New scripts are Python, run from `.venv/bin/python` by absolute path (`$(PY)` in the Makefile); shared helpers come from `infra/scripts/lib3mrai/` (`aws.client`, `console.ok/no/inf`).
- Run `nvm use` before any Node command; pnpm only.
- Code comments: tags `CONTRACT:`/`WORKAROUND(<scope>):`/`WHY:`/`WARNING:`/`TODO(JE-<id>):`, present tense, `See [[note]]`; `make lint-comments` must pass.
- Vault writes go through `obsidian-vault`; implementers never write `docs/`.
- Implementers never run git writes; the main session commits through the A/B/C/D/E menu.

## Review Focus

1. **Docker daemon restart (Docker Desktop quit/relaunch)** — Floci comes back but DocumentDB/Valkey stay `Exited`; `make heal` must restart them with data intact, not recreate them empty. Pinned by Task 2's `test_starts_exited_backing_containers_without_recreating`.
2. **ECS looks healthy while nothing runs** — after a restart `runningCount` reports 1 before any task container exists; doctor must poke the ECS API before judging. Pinned by Task 3's `test_doctor_wakes_ecs_before_checking`.
3. **Orphan task containers** — after a SIGKILL the pre-restart task keeps running beside the new one; heal must remove only containers whose task id is absent from `list-tasks`, never a live one. Pinned by Task 2's `test_removes_only_orphan_task_containers`.
4. **Truly deleted container** (someone ran `docker rm`) — heal cannot help; doctor must say "rebuild", not "heal". Pinned by Task 3's `test_missing_container_remedy_is_rebuild`.
5. **Second `terraform apply` on 2.1.0** — quirk 9 may or may not still hold; `infra-up` behaviour depends on it. Pinned by Task 5's explicit re-verification step.

---

### Task 1: Pin Floci 2.1.0 with a curl-free healthcheck and SIGKILL stop

**Files:**
- Modify: `docker-compose.yml` (the `floci` service, lines 33-106)

**Interfaces:**
- Consumes: nothing.
- Produces: a `floci` service that survives restart/recreate with its DocumentDB/Valkey containers intact (Tasks 2, 5 rely on it).

- [ ] **Step 1: Change the image, add `stop_signal`, replace the healthcheck**

In `docker-compose.yml`, replace `image: floci/floci:latest` with:

```yaml
    # CONTRACT: Pinned. `latest` moved 1.7.0 -> 2.x under this repo once already,
    # changing restart semantics and dropping curl from the image.
    image: floci/floci:2.1.0
    # CONTRACT: SIGKILL, never the default SIGTERM. Floci's graceful shutdown
    # DELETES its DocumentDB and ElastiCache containers and never relaunches them,
    # so a plain restart leaves both `available` in the API with no container and
    # no data. Killed, Floci skips that shutdown and the containers keep their data.
    # Safe only with FLOCI_STORAGE_MODE=persistent below.
    # See [[floci-recreate-destroys-backing-containers]]
    stop_signal: SIGKILL
```

Replace the existing `healthcheck:` block (comment included) with:

```yaml
    healthcheck:
      # WHY: bash /dev/tcp, not curl — the 2.x image ships bash and coreutils only.
      test: ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/4566 && printf 'GET / HTTP/1.0\\r\\n\\r\\n' >&3 && read -r status <&3 && [[ $$status == *' 200 '* ]]"]
      interval: 10s
      timeout: 3s
      retries: 5
```

- [ ] **Step 2: Rebuild from scratch and check health**

Run: `make clean && make bootstrap`
Then: `docker inspect 3mrai-floci-1 -f '{{.Config.Image}} {{.Config.StopSignal}} {{.State.Health.Status}}'`
Expected: `floci/floci:2.1.0 SIGKILL healthy`

- [ ] **Step 3: Prove persistence across a restart**

```bash
docker exec floci-valkey-cache-3mrai-local-cache-redis valkey-cli SET heal-probe kept
docker compose --env-file .env.local.web restart floci
sleep 20
docker exec floci-valkey-cache-3mrai-local-cache-redis valkey-cli GET heal-probe
```
Expected: `kept`. Also `docker ps --format '{{.Names}}' | grep -c floci-docdb-` prints `1`.

- [ ] **Step 4: Hand over for commit**

Proposed message: `build(infra): pin Floci 2.1.0 with a SIGKILL stop and curl-free healthcheck`

---

### Task 2: `floci_heal.py` and `make heal`

**Files:**
- Create: `infra/scripts/floci_heal.py`
- Create: `infra/scripts/tests/test_floci_heal.py`
- Modify: `Makefile` (new `heal` target after `doctor`, line ~484)

**Interfaces:**
- Consumes: `lib3mrai.aws.client(service)`, `lib3mrai.console.ok/no/inf`.
- Produces (used by Task 3 and by the pre-prod plan):
  - `wake_ecs(ecs) -> list[str]` — calls `list_clusters`, returns cluster ARNs.
  - `live_task_ids(ecs, cluster_arns: list[str]) -> set[str]` — the hex task ids of RUNNING/PENDING tasks.
  - `orphan_task_containers(container_names: list[str], live: set[str]) -> list[str]` — names `floci-ecs-<taskId>-<container>` whose task id is not in `live`.
  - `exited_backing_containers(docker) -> list[str]` — names of `Exited` containers labelled `io.floci.service` ∈ {`docdb`, `elasticache`}.
  - `main(argv: list[str] | None = None) -> int`.
  - `docker(*args) -> str` — thin `subprocess.run(["docker", *args])` returning stdout; tests inject a fake.

- [ ] **Step 1: Write the failing tests**

```python
"""Tests for floci_heal.py — recovery after a Floci or Docker restart."""

import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock

SCRIPT = Path(__file__).resolve().parents[1] / "floci_heal.py"
sys.path.insert(0, str(SCRIPT.parent))
_spec = importlib.util.spec_from_file_location("floci_heal", SCRIPT)
heal = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(heal)


def test_wake_ecs_lists_clusters():
    ecs = MagicMock()
    ecs.list_clusters.return_value = {"clusterArns": ["arn:c1"]}
    assert heal.wake_ecs(ecs) == ["arn:c1"]
    ecs.list_clusters.assert_called_once()


def test_live_task_ids_strips_arn_prefix():
    ecs = MagicMock()
    ecs.list_tasks.return_value = {
        "taskArns": ["arn:aws:ecs:us-east-1:000000000000:task/c1/abc123"]
    }
    assert heal.live_task_ids(ecs, ["arn:c1"]) == {"abc123"}


def test_removes_only_orphan_task_containers():
    names = [
        "floci-ecs-abc123-nginx",
        "floci-ecs-dead99-nginx",
        "floci-docdb-db-x",
    ]
    assert heal.orphan_task_containers(names, {"abc123"}) == ["floci-ecs-dead99-nginx"]


def test_starts_exited_backing_containers_without_recreating():
    calls = []

    by_label = {
        "label=io.floci.service=docdb": "floci-docdb-db-x\n",
        "label=io.floci.service=elasticache": "floci-valkey-cache-y\n",
    }

    def fake_docker(*args):
        calls.append(args)
        return next((out for label, out in by_label.items() if label in args), "")

    assert heal.exited_backing_containers(fake_docker) == [
        "floci-docdb-db-x",
        "floci-valkey-cache-y",
    ]
    assert all("status=exited" in call for call in calls)
    assert not any(a in ("rm", "create", "run") for call in calls for a in call)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest infra/scripts/tests/test_floci_heal.py -v`
Expected: FAIL — `FileNotFoundError` / module has no attribute `wake_ecs`.

- [ ] **Step 3: Write the implementation**

```python
"""Recover a Floci stack after a Floci or Docker daemon restart.

Three gaps Floci 2.x leaves, each verified: DocumentDB/Valkey containers stay
Exited after a daemon restart; the ECS service reconciler does nothing until the
first ECS API call; a SIGKILLed Floci leaves the pre-restart task container
running beside its replacement. See [[floci-recreate-destroys-backing-containers]]
"""

from __future__ import annotations

import re
import subprocess
import sys

from lib3mrai.aws import client
from lib3mrai.console import inf, no, ok

BACKING_SERVICES = ("docdb", "elasticache")
TASK_CONTAINER = re.compile(r"^floci-ecs-([0-9a-f]{32})-")


def docker(*args: str) -> str:
    return subprocess.run(
        ["docker", *args], capture_output=True, text=True, check=False
    ).stdout


def wake_ecs(ecs) -> list[str]:
    return ecs.list_clusters().get("clusterArns", [])


def live_task_ids(ecs, cluster_arns: list[str]) -> set[str]:
    ids: set[str] = set()
    for arn in cluster_arns:
        for task in ecs.list_tasks(cluster=arn).get("taskArns", []):
            ids.add(task.rsplit("/", 1)[-1])
    return ids


def orphan_task_containers(container_names: list[str], live: set[str]) -> list[str]:
    orphans = []
    for name in container_names:
        match = TASK_CONTAINER.match(name)
        if match and match.group(1) not in live:
            orphans.append(name)
    return orphans


def exited_backing_containers(run=docker) -> list[str]:
    names: list[str] = []
    for service in BACKING_SERVICES:
        out = run(
            "ps", "-a",
            "--filter", "status=exited",
            "--filter", f"label=io.floci.service={service}",
            "--format", "{{.Names}}",
        )
        names.extend(n for n in out.split() if n)
    return names


def main(argv: list[str] | None = None) -> int:
    ecs = client("ecs")
    clusters = wake_ecs(ecs)
    ok(f"ECS reconciler woken ({len(clusters)} cluster(s))")

    exited = exited_backing_containers()
    for name in exited:
        docker("start", name)
        ok(f"restarted {name}")
    if not exited:
        inf("    no exited DocumentDB/Valkey containers")

    running = docker("ps", "--format", "{{.Names}}").split()
    orphans = orphan_task_containers(running, live_task_ids(ecs, clusters))
    for name in orphans:
        docker("rm", "-f", name)
        ok(f"removed orphan task container {name}")
    if not orphans:
        inf("    no orphan ECS task containers")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest infra/scripts/tests/test_floci_heal.py -v`
Expected: 4 passed.

- [ ] **Step 5: Add the Makefile target**

After the `doctor` recipe (line ~483):

```make
heal: scripts-setup ## Recover after a Floci/Docker restart: start exited DocDB/Valkey, wake ECS, drop orphan tasks
	$(PY) infra/scripts/floci_heal.py
```

Add `heal` to the `.PHONY` list if the Makefile declares one.

- [ ] **Step 6: Verify against a real daemon-style restart**

```bash
docker exec floci-valkey-cache-3mrai-local-cache-redis valkey-cli SET heal-probe kept
docker kill -s KILL 3mrai-floci-1
docker stop floci-valkey-cache-3mrai-local-cache-redis $(docker ps --format '{{.Names}}' | grep floci-docdb-)
docker compose --env-file .env.local.web start floci && sleep 15
make heal
docker exec floci-valkey-cache-3mrai-local-cache-redis valkey-cli GET heal-probe
```
Expected: heal prints `restarted floci-docdb-…`, `restarted floci-valkey-…`; the GET prints `kept`.

- [ ] **Step 7: Hand over for commit**

Proposed message: `feat(infra): add make heal for Floci and Docker restarts`

---

### Task 3: Doctor distinguishes healable from gone

**Files:**
- Modify: `infra/scripts/doctor.py` (`check_docdb_host` L199-226, `check_phantom_resources` L229-279, `main` L668-709)
- Create: `infra/scripts/tests/test_doctor_backing.py`

**Interfaces:**
- Consumes: `lib3mrai.aws.client`, the existing `_docker` helper in `doctor.py`.
- Produces: `backing_state(name: str, run=_docker_stdout) -> str` returning `"running" | "exited" | "missing"`; `remedy_for(state: str) -> str`.

- [ ] **Step 1: Write the failing tests**

```python
"""Tests for doctor's backing-container classification."""

import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

SCRIPT = Path(__file__).resolve().parents[1] / "doctor.py"
sys.path.insert(0, str(SCRIPT.parent))
_spec = importlib.util.spec_from_file_location("doctor", SCRIPT)
doctor = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(doctor)


def test_backing_state_running():
    assert doctor.backing_state("x", run=lambda *a: "Up 3 minutes\n") == "running"


def test_backing_state_exited():
    assert doctor.backing_state("x", run=lambda *a: "Exited (0) 5 seconds ago\n") == "exited"


def test_backing_state_missing():
    assert doctor.backing_state("x", run=lambda *a: "") == "missing"


def test_exited_container_remedy_is_heal():
    assert doctor.remedy_for("exited") == "make heal"


def test_missing_container_remedy_is_rebuild():
    assert doctor.remedy_for("missing") == "make clean && make bootstrap"


def test_doctor_wakes_ecs_before_checking():
    ecs = MagicMock()
    ecs.list_clusters.return_value = {"clusterArns": []}
    with patch.object(doctor, "client", return_value=ecs):
        doctor.wake_ecs_reconciler()
    ecs.list_clusters.assert_called_once()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest infra/scripts/tests/test_doctor_backing.py -v`
Expected: FAIL — `AttributeError: module 'doctor' has no attribute 'backing_state'`.

- [ ] **Step 3: Implement**

Add near the other helpers in `doctor.py` (imports: `from lib3mrai.aws import client`):

```python
def _docker_stdout(*args: str) -> str:
    return _docker(*args).stdout


def backing_state(name: str, run=_docker_stdout) -> str:
    """`running`, `exited` (data intact, `make heal` restarts it) or `missing`."""
    status = run("ps", "-a", "--filter", f"name=^{name}$", "--format", "{{.Status}}").strip()
    if not status:
        return "missing"
    return "running" if status.startswith("Up") else "exited"


def remedy_for(state: str) -> str:
    return "make heal" if state == "exited" else "make clean && make bootstrap"


def wake_ecs_reconciler() -> None:
    """WORKAROUND(local): Floci's ECS reconciler idles until the first ECS call."""
    client("ecs").list_clusters()
```

In `check_docdb_host`, replace the `if _docker("ps", …)` block with:

```python
    state = backing_state(host)
    if state == "running":
        report.passed(f"DocumentDB container '{host}' running")
    else:
        report.failed(
            f"DOCDB_HOST '{host}' is {state} — the events pipeline cannot reach it",
            remedy_for(state),
        )
```

In `check_phantom_resources`, replace the inner `found = …` / `if found.stdout.strip():` block with:

```python
            state = backing_state(container)
            if state == "running":
                report.passed(f"{label} '{identifier}' has a running container")
            else:
                report.failed(
                    f"{label} '{identifier}' reports available but its container "
                    f"({container}) is {state}",
                    remedy_for(state),
                )
```

In `main`, call `wake_ecs_reconciler()` right after `check_floci` succeeds, before `check_containers`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest infra/scripts/tests/ -v`
Expected: all pass (existing `test_envfile.py`, `test_execution_log.py` included).

- [ ] **Step 5: Verify against the stack**

`docker stop floci-valkey-cache-3mrai-local-cache-redis && make doctor` → the ElastiCache line fails with `fix: make heal`. Then `make heal && make doctor` → all checks pass.

- [ ] **Step 6: Hand over for commit**

Proposed message: `feat(infra): make doctor tell healable containers from gone ones`

---

### Task 4: Provider endpoints, docdb contract, ECR leftovers in `make clean`

**Files:**
- Modify: `infra/environments/local/providers.tf` (the `endpoints {}` block)
- Modify: `infra/modules/docdb/main.tf:127-132`
- Modify: `Makefile` (`clean` L684-744 and `clean-state` L746-777)

**Interfaces:**
- Consumes: nothing. Produces: a provider that never silently targets real AWS for `ssm`, `ecr`, `s3`, `elasticache`.

- [ ] **Step 1: Add the endpoints**

Inside `endpoints {}` in `infra/environments/local/providers.tf`, add (alphabetical with the rest):

```hcl
    ecr         = "http://localhost:4566"
    elasticache = "http://localhost:4566"
    s3          = "http://localhost:4566"
    ssm         = "http://localhost:4566"
```

- [ ] **Step 2: Rewrite the docdb contract to the present truth**

Replace lines 127-132 of `infra/modules/docdb/main.tf` with:

```hcl
# ─── No Parameter Store entries ───────────────────────────────────────────────────
# WHY: Nothing reads them — every consumer takes host/port from `terraform output`.
# CONTRACT: A root that adds `aws_ssm_parameter` must declare the `ssm` provider
# endpoint; undeclared, the provider signs against real AWS and fails with
# `UnrecognizedClientException`, which reads like a Floci limitation and is not.
```

- [ ] **Step 3: Sweep the ECR registry volume in `clean` and `clean-state`**

After the `docker volume ls -q --filter label=floci=true …` line in BOTH recipes, add:

```make
	@# CONTRACT: Remove the ECR registry volume by name. Floci keeps the registry
	@# container running across its own shutdown and the volume carries no compose
	@# or floci label, so the sweeps above miss it; kept, Floci reports every old
	@# repository as existing and the next apply fails with RepositoryAlreadyExists.
	@docker volume rm -f floci-ecr-registry-data 2>/dev/null || true
```

(The `name=^floci-` container sweep already removes `floci-ecr-registry`.)

- [ ] **Step 4: Validate**

Run: `terraform -chdir=infra/environments/local validate && terraform fmt -check -recursive infra && make lint-comments`
Expected: `Success! The configuration is valid.`, no fmt diff, lint clean.

- [ ] **Step 5: Hand over for commit**

Proposed message: `fix(infra): declare every provider endpoint and sweep the ECR volume on clean`

---

### Task 5: Re-verify the Floci quirks on 2.1.0 and update the knowledge layer

**Files:**
- Modify: `.claude/skills/floci/SKILL.md` (quirks 6, 9, 13, 15, 16, 17 and the "ships `curl`" line)
- Vault (via `obsidian-vault`): `docs/lessons/floci-recreate-destroys-backing-containers.md`, `docs/lessons/floci-storage-modes-and-tmp-corruption.md`, `docs/lessons/floci-vs-ministack-spike-findings.md`, new `docs/lessons/2026-10-02-floci-2-1-restart-and-gateway-findings.md`

**Interfaces:**
- Consumes: Tasks 1-4 on a running stack.
- Produces: the verified 2.1.0 behaviour record the pre-prod plan cites.

- [ ] **Step 1: Full suite on the new stack**

Run: `make clean && make bootstrap && make doctor && make test-all`
Expected: doctor green; test-all failures, if any, compared against a 1.7.0 baseline run of the same commit — a failure that also fails on 1.7.0 is not a regression of this plan (see [[e2e-variance-exceeds-effect]]).

- [ ] **Step 2: Re-verify quirk 9 (second apply)**

Run: `terraform -chdir=infra/environments/local apply -auto-approve` twice in a row.
Record verbatim: does the second apply print `No changes.` or fail with `UpdateTags`/`Invalid API id`? This decides whether `infra-up`'s reconcile path still matters.

- [ ] **Step 3: Update the skill**

Edit `.claude/skills/floci/SKILL.md`:
- Base setup: image pinned `floci/floci:2.1.0`; standard image has bash+coreutils, no curl.
- Quirk 6: Cloud Map still does not register ECS tasks nor resolve names (re-verified on 2.1.0).
- Quirk 9: the Step 2 result.
- Quirk 13: CloudFront delivery still absent in 2.1.0 (docs describe nightly builds).
- Quirk 15: `FLOCI_DOCKER_EXTRA_LABELS_N__KEY/VALUE` exists for labels (untested here).
- Quirk 16/17: on 2.1.0 a plain stop/start deletes DocumentDB/Valkey; fix = `stop_signal: SIGKILL` + `make heal`; ECS reconciler is lazy; delete+recreate no longer wedges.
- New quirk 18: API GW v2 `request_parameters` `overwrite:header.<h> = $context.authorizer.claims.sub` and `overwrite:path` work (2.1.0); `awslogs-group` is ignored (`/ecs/<family>`); ECR URIs always use `:4566`.

- [ ] **Step 4: Route the vault updates**

Dispatch `obsidian-vault` (English output) with the facts of this plan's Tasks 1-5 and the spec's "Feasibility evidence" section: update the three lesson notes above and create the dated lesson note; run `nvm use && node scripts/validate-vault.mjs`.

- [ ] **Step 5: Hand over for commit**

Proposed message: `docs(infra): record Floci 2.1.0 restart and gateway behaviour`

## Related

- [[2026-10-02-floci-preprod-environment-design]]
- [[2026-10-02-floci-preprod-environment]]
- [[floci-recreate-destroys-backing-containers]]
- [[floci-storage-modes-and-tmp-corruption]]
- [[floci-vs-ministack-spike-findings]]
- [[local-dev-floci]]
