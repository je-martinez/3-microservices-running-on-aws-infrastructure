---
title: "Diagram-Design Migration — Implementation Plan"
type: plan
area: shared
status: accepted
created: 2026-10-13
updated: 2026-10-18
tags:
  - type/plan
  - area/shared
  - status/accepted
related:
  - "[[2026-10-13-diagram-design-migration-design]]"
  - "[[diagrams]]"
  - "[[ADR-0023-remotion-diagrams]]"
  - "[[ADR-0024-diagram-design-diagrams]]"
  - "[[git-workflow]]"
propagates-to:
  - "[[diagrams]]"
  - "[[git-workflow]]"
  - "[[diagram-legibility]]"
  - "[[ADR-0023-remotion-diagrams]]"
  - "[[ADR-0024-diagram-design-diagrams]]"
  - "[[architecture]]"
  - "[[system-context]]"
---

# Diagram-Design Migration Implementation Plan

> **Execution note (2026-10-18):** Decisions made on 2026-10-14..18, after this plan closed, are listed in the spec's [[2026-10-13-diagram-design-migration-design#Amendments (2026-10-14 – 2026-10-18)|Amendments]]. They supersede the plan lines that tolerate only AWS icons and that give Stripe, Geoapify and OpenObserve the `internet` icon (Global Constraints, Architecture and the icon tasks). Current source: [[ADR-0024-diagram-design-diagrams]] and [[diagrams]]. No checkbox below was changed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Remotion/ELK `diagrams/` package with hand-authored `diagram-design` HTML sources plus a slim Python toolchain (catalog, drift check, gate, PNG render), migrate all 29 diagrams, and retire Remotion everywhere.

**Architecture:** Each diagram is one self-contained `diagram-design` HTML file under `diagrams/src/<group>/<id>.html`, listed in `diagrams/catalog.yaml`. A Python package `diagrams3mrai` (installed into the repo `.venv` by `make diagrams-setup`) gates each source (the skill's `self_check.py`, filtered to tolerate only allow-listed jsDelivr AWS icons, plus a width cap), renders it to a PNG beside its vault note with Playwright, and reports drift against `watches`.

**Tech Stack:** Python 3.13, PyYAML, Playwright (Python, Chromium), pytest; `diagram-design` plugin skill v2.6.6; AWS icons from `https://cdn.jsdelivr.net/npm/aws-icons@3.2.0/`.

**Spec:** [[2026-10-13-diagram-design-migration-design]] (`docs/superpowers/specs/2026-10-13-diagram-design-migration-design.md`)

## Global Constraints

- Branch: all work on `feature/remotion-diagrams`; PR #130 is updated, never merged by an agent.
- Every commit goes through the A/B/C/D/E menu (AskUserQuestion). Dispatched agents never run git writes.
- Style: the skill's default style; repo-root `.diagram-design` contains exactly `profile: default` and one final newline.
- Icons: only `https://cdn.jsdelivr.net/npm/aws-icons@3.2.0/icons/<folder>/<Name>.svg`, folder ∈ {`architecture-service`, `architecture-group`, `resource`, `category`}, and only paths listed in `diagrams/icons.yaml`. Version pinned to `3.2.0`.
- Max `viewBox` width: 2000.
- No GIF anywhere. Outputs are `docs/**/diagrams/<id>.png` only.
- Flows use `data-motion-mode="step"` with the controller copied verbatim from the skill's `assets/template-motion.html`; the PNG is the static complete frame with numbered step badges in the SVG.
- Node budget: ≤9 nodes default; `faithful` ≤24 nodes, zoned above 9; ≤3 zones per architecture diagram.
- Coverage rule: every runtime AWS service gets a node; no runtime service disappears from a view without an explicit user decision.
- New scripts are Python, run from `.venv/bin/python` by absolute path in the Makefile. `diagrams-setup` is NOT a dependency of `scripts-setup`.
- pnpm only (never npm/npx); run `nvm use` before any Node command.
- Code comments use the five tags of [[code-comments]]; `make lint-comments` stays green.
- Vault writes (`docs/**/*.md`) go through `obsidian-vault`; `diagram-impl` writes only `diagrams/**` and `docs/**/diagrams/*.png`.

## Review Focus

- A mistyped or unpinned icon URL (`aws-icons@latest`, `@3.2.1`, wrong file name) must fail the gate, not render a blank square → Task 3 tests `test_unpinned_version_fails`, `test_unlisted_icon_fails`, and the manifest reachability check.
- `self_check.py` truncates the URL in its error to 80 chars, so a non-manifest path under the same prefix could hide behind the filter → Task 3 `test_prefix_match_alone_is_not_enough` proves the gate's own parser catches it.
- A PNG captured before icons or fonts finished loading, or mid-animation, looks plausible but is wrong → Task 4 render fails on any failed/4xx icon request and asserts `data-frame="static"` when a motion root exists (`test_render_fails_on_missing_icon`, `test_render_static_frame`).
- `make diagrams-render ID=typo` must error, not silently render nothing → Task 1 `test_select_unknown_id_raises`.
- A diagram HTML added without a catalog entry (or vice versa) slips past drift and the vault → Task 3 `test_orphan_html_fails` and `test_missing_src_fails`.

---

### Task 1: Python package scaffold and catalog

**Files:**
- Create: `diagrams/pyproject.toml`
- Create: `diagrams/diagrams3mrai/__init__.py`
- Create: `diagrams/diagrams3mrai/catalog.py`
- Create: `diagrams/catalog.yaml`
- Create: `diagrams/tests/test_catalog.py`
- Create: `.diagram-design`
- Modify: `Makefile` (add `diagrams-setup`)

**Interfaces:**
- Produces: `diagrams3mrai.catalog.REPO_ROOT: Path`, `CATALOG_PATH: Path`, `GROUPS = ("architecture", "system-context", "flows", "milestones")`, `@dataclass(frozen=True) Entry(id: str, title: str, src: str, output: str, watches: tuple[str, ...])` with property `png -> str` (`f"{output}.png"`), `load_catalog(path: Path = CATALOG_PATH) -> list[Entry]`, `select(entries: list[Entry], ids: list[str]) -> list[Entry]` (empty `ids` → all; unknown id → `KeyError` naming it).

- [x] **Step 1: Create the package metadata and marker**

`diagrams/pyproject.toml`:
```toml
[project]
name = "diagrams3mrai"
version = "0.1.0"
description = "3MRAI diagram toolchain: catalog, drift check, gate and PNG render for diagram-design sources"
requires-python = ">=3.13"
# WHY: PurePosixPath.full_match (3.13+) gives "**" glob semantics without a picomatch port.
dependencies = ["pyyaml>=6,<7", "playwright>=1.47,<2"]

[project.optional-dependencies]
dev = ["pytest>=8,<9"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["diagrams3mrai*"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

`diagrams/diagrams3mrai/__init__.py`: empty file.

`.diagram-design` (repo root, exactly one line plus newline):
```text
profile: default
```

- [x] **Step 2: Add `diagrams-setup` to the Makefile**

Add `diagrams-setup` to the `.PHONY` list and this target next to the other `diagrams-*` targets:
```make
diagrams-setup: $(PY) ## Install the diagram toolchain (Playwright + Chromium) into .venv; not needed by any apply target
	$(VENV)/bin/pip install -q -e "diagrams[dev]"
	$(VENV)/bin/python -m playwright install chromium
```

Run: `make diagrams-setup`
Expected: exits 0; `.venv/bin/python -c "import yaml, playwright"` succeeds.

- [x] **Step 3: Write the failing catalog tests**

`diagrams/tests/test_catalog.py`:
```python
from pathlib import Path

import pytest

from diagrams3mrai.catalog import CATALOG_PATH, Entry, load_catalog, select


def write(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "catalog.yaml"
    p.write_text(body)
    return p


GOOD = """
entries:
  - id: arch
    title: Arch
    src: diagrams/src/architecture/arch.html
    output: docs/00-overview/diagrams/arch
    watches: ["infra/modules/**"]
  - id: otp
    title: OTP
    src: diagrams/src/flows/otp.html
    output: docs/domains/users/specs/diagrams/otp
    watches: []
"""


def test_loads_entries_and_png_path(tmp_path):
    entries = load_catalog(write(tmp_path, GOOD))
    assert [e.id for e in entries] == ["arch", "otp"]
    assert entries[0].png == "docs/00-overview/diagrams/arch.png"
    assert entries[0].watches == ("infra/modules/**",)


def test_duplicate_id_raises(tmp_path):
    body = GOOD.replace("id: otp", "id: arch")
    with pytest.raises(ValueError, match="duplicate catalog ids: \\['arch'\\]"):
        load_catalog(write(tmp_path, body))


@pytest.mark.parametrize(
    "bad_src",
    ["diagrams/src/other/arch.html", "diagrams/src/architecture/wrong.html", "diagrams/src/architecture/arch.svg"],
)
def test_src_must_be_group_slash_id_html(tmp_path, bad_src):
    body = GOOD.replace("diagrams/src/architecture/arch.html", bad_src)
    with pytest.raises(ValueError, match="arch: src"):
        load_catalog(write(tmp_path, body))


@pytest.mark.parametrize("bad_output", ["out/arch", "docs/00-overview/diagrams/arch.png"])
def test_output_must_be_docs_path_without_extension(tmp_path, bad_output):
    body = GOOD.replace("docs/00-overview/diagrams/arch", bad_output, 1)
    with pytest.raises(ValueError, match="arch: output"):
        load_catalog(write(tmp_path, body))


def test_select_empty_returns_all(tmp_path):
    entries = load_catalog(write(tmp_path, GOOD))
    assert select(entries, []) == entries


def test_select_unknown_id_raises(tmp_path):
    entries = load_catalog(write(tmp_path, GOOD))
    with pytest.raises(KeyError, match="typo"):
        select(entries, ["arch", "typo"])


def test_real_catalog_has_29_entries():
    assert len(load_catalog(CATALOG_PATH)) == 29
```

- [x] **Step 4: Run tests to verify they fail**

Run: `cd diagrams && ../.venv/bin/python -m pytest tests/test_catalog.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'diagrams3mrai.catalog'`.

- [x] **Step 5: Implement `catalog.py`**

`diagrams/diagrams3mrai/catalog.py`:
```python
"""Load and validate diagrams/catalog.yaml, the list of every diagram and what it watches."""

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = REPO_ROOT / "diagrams" / "catalog.yaml"
GROUPS = ("architecture", "system-context", "flows", "milestones")


@dataclass(frozen=True)
class Entry:
    id: str
    title: str
    src: str
    output: str
    watches: tuple[str, ...]

    @property
    def png(self) -> str:
        return f"{self.output}.png"


def _validate(e: Entry) -> None:
    groups = "|".join(re.escape(g) for g in GROUPS)
    if not re.fullmatch(rf"diagrams/src/({groups})/{re.escape(e.id)}\.html", e.src):
        raise ValueError(f"{e.id}: src must be diagrams/src/<group>/{e.id}.html, got {e.src}")
    if not e.output.startswith("docs/") or Path(e.output).suffix:
        raise ValueError(f"{e.id}: output must be a docs/ path without extension, got {e.output}")


def load_catalog(path: Path = CATALOG_PATH) -> list[Entry]:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    entries = [
        Entry(id=r["id"], title=r["title"], src=r["src"], output=r["output"], watches=tuple(r.get("watches") or ()))
        for r in raw["entries"]
    ]
    ids = [e.id for e in entries]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        raise ValueError(f"duplicate catalog ids: {dup}")
    for e in entries:
        _validate(e)
    return entries


def select(entries: list[Entry], ids: list[str]) -> list[Entry]:
    if not ids:
        return entries
    by_id = {e.id: e for e in entries}
    unknown = [i for i in ids if i not in by_id]
    if unknown:
        raise KeyError(f"unknown diagram id(s): {', '.join(unknown)}")
    return [by_id[i] for i in ids]
```

- [x] **Step 6: Generate `catalog.yaml` from the Remotion catalog (one-off, not committed)**

The TS catalog is the source of truth until Task 9 deletes it. Export it once:
```bash
nvm use
pnpm --filter @3mrai/diagrams exec tsx -e 'import("./src/catalog.ts").then(({catalog}) => console.log(JSON.stringify(catalog.map(e => ({id: e.id, title: e.title, output: e.output, watches: e.watches, source: e.source})))))' > /tmp/catalog.json
.venv/bin/python - <<'PY'
import json, yaml
rows = json.load(open("/tmp/catalog.json"))
out = []
for r in rows:
    group = r["source"].split("/")[3]  # diagrams/src/data/<group>/<file>.ts
    out.append({"id": r["id"], "title": r["title"], "src": f"diagrams/src/{group}/{r['id']}.html",
                "output": r["output"], "watches": r["watches"]})
header = "# Every diagram: its diagram-design source, its PNG output (no extension) and the paths whose change may make it stale.\n"
open("diagrams/catalog.yaml", "w").write(header + yaml.safe_dump({"entries": out}, sort_keys=False, width=200))
PY
```
Check: `grep -c '^  - id:' diagrams/catalog.yaml` → `29`; every `src` group is one of `architecture`, `system-context`, `flows`, `milestones`.

- [x] **Step 7: Run tests to verify they pass**

Run: `cd diagrams && ../.venv/bin/python -m pytest tests/test_catalog.py -v`
Expected: PASS (all).

- [x] **Step 8: Commit (via the A/B/C/D/E menu)**

```bash
git add .diagram-design Makefile diagrams/pyproject.toml diagrams/diagrams3mrai diagrams/catalog.yaml diagrams/tests/test_catalog.py
git commit -m "build(diagrams): add the diagram-design python toolchain and catalog"
```

---

### Task 2: Drift check port

**Files:**
- Create: `diagrams/diagrams3mrai/drift.py`
- Create: `diagrams/tests/test_drift.py`
- Modify: `Makefile` (`diagrams-check` recipe)

**Interfaces:**
- Consumes: `Entry`, `load_catalog`, `REPO_ROOT` from Task 1.
- Produces: `SHARED_RENDER_GLOBS: tuple[str, ...]`, `TEST_GLOBS: tuple[str, ...]`, `@dataclass(frozen=True) DriftResult(id: str, status: Literal["stale", "updated"], matches: tuple[str, ...])`, `affected(changed: list[str], entries: list[Entry]) -> list[DriftResult]`, `main() -> int` (always 0), runnable as `python -m diagrams3mrai.drift`.

- [x] **Step 1: Write the failing tests**

`diagrams/tests/test_drift.py`:
```python
import pytest

from diagrams3mrai.catalog import Entry
from diagrams3mrai.drift import DriftResult, affected

ENTRIES = [
    Entry("arch", "Arch", "diagrams/src/architecture/arch.html", "docs/00-overview/diagrams/arch",
          ("infra/modules/**", "docker-compose.yml")),
    Entry("otp", "OTP", "diagrams/src/flows/otp.html", "docs/domains/users/specs/diagrams/otp",
          ("infra/modules/cognito/**", "services/users/src/**")),
]


def test_nothing_when_no_watched_path_changed():
    assert affected(["README.md"], ENTRIES) == []


def test_flags_every_matching_entry_as_stale():
    assert affected(["infra/modules/cognito/main.tf"], ENTRIES) == [
        DriftResult("arch", "stale", ("infra/modules/cognito/main.tf",)),
        DriftResult("otp", "stale", ("infra/modules/cognito/main.tf",)),
    ]


def test_updated_when_png_changed_alongside():
    assert affected(["docker-compose.yml", "docs/00-overview/diagrams/arch.png"], ENTRIES) == [
        DriftResult("arch", "updated", ("docker-compose.yml",)),
    ]


def test_render_only_diff_is_ignored():
    assert affected(["docs/00-overview/diagrams/arch.png"], ENTRIES) == []


def test_own_src_is_an_implicit_watch():
    assert affected(["diagrams/src/flows/otp.html"], ENTRIES) == [
        DriftResult("otp", "stale", ("diagrams/src/flows/otp.html",)),
    ]


@pytest.mark.parametrize("f", ["diagrams/diagrams3mrai/render.py", "diagrams/icons.yaml", "diagrams/pyproject.toml", ".diagram-design"])
def test_shared_render_change_flags_every_entry(f):
    assert [(r.id, r.status) for r in affected([f], ENTRIES)] == [("arch", "stale"), ("otp", "stale")]


@pytest.mark.parametrize("f", [
    "services/users/src/users/commands/register.command.test.ts",
    "services/users/src/users/register.spec.ts",
    "infra/modules/cognito/main_test.go",
    "services/users/src/test/helpers.ts",
    "services/users/src/tests/fixtures.ts",
    "services/users/src/__tests__/x.ts",
])
def test_test_files_never_flag(f):
    assert affected([f], ENTRIES) == []


def test_single_star_does_not_cross_directories():
    e = [Entry("c", "C", "diagrams/src/flows/c.html", "docs/x/c", ("services/*/src/shared/cache/**",))]
    assert [r.id for r in affected(["services/orders/src/shared/cache/a.ts"], e)] == ["c"]
    assert affected(["services/orders/extra/src/shared/cache/a.ts"], e) == []
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd diagrams && ../.venv/bin/python -m pytest tests/test_drift.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'diagrams3mrai.drift'`.

- [x] **Step 3: Implement `drift.py`**

`diagrams/diagrams3mrai/drift.py`:
```python
"""Warn about diagrams whose watched sources changed since a base ref without a re-render. Never fails."""

import os
import subprocess
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Literal

from diagrams3mrai.catalog import REPO_ROOT, Entry, load_catalog

# Rendering inputs every diagram depends on: a change here may alter any render.
SHARED_RENDER_GLOBS = (
    "diagrams/diagrams3mrai/render.py",
    "diagrams/icons.yaml",
    "diagrams/pyproject.toml",
    ".diagram-design",
)
# Tests never change what a diagram depicts, so they never make one stale.
TEST_GLOBS = ("**/*.test.*", "**/*.spec.*", "**/*_test.go", "**/test/**", "**/tests/**", "**/__tests__/**")


@dataclass(frozen=True)
class DriftResult:
    id: str
    status: Literal["stale", "updated"]
    matches: tuple[str, ...]


def _matches(path: str, globs: tuple[str, ...]) -> bool:
    p = PurePosixPath(path)
    return any(p.full_match(g) for g in globs)


def affected(changed: list[str], entries: list[Entry]) -> list[DriftResult]:
    relevant = [f for f in changed if not _matches(f, TEST_GLOBS)]
    results = []
    for e in entries:
        globs = (*e.watches, e.src, *SHARED_RENDER_GLOBS)
        hits = tuple(f for f in relevant if _matches(f, globs))
        if not hits:
            continue
        results.append(DriftResult(e.id, "updated" if e.png in changed else "stale", hits))
    return results


def _git(*args: str) -> list[str]:
    out = subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=True).stdout
    return [line for line in out.splitlines() if line]


def main() -> int:
    base = os.environ.get("DIAGRAMS_BASE", "main")
    try:
        entries = load_catalog()
        local = [*_git("diff", "--name-only", "HEAD"), *_git("ls-files", "--others", "--exclude-standard")]
        try:
            merge_base = _git("merge-base", base, "HEAD")[0]
            changed = list(dict.fromkeys([*_git("diff", "--name-only", merge_base, "HEAD"), *local]))
        except (subprocess.CalledProcessError, IndexError):
            print(f'diagrams-check: warning — base "{base}" could not be resolved; checking uncommitted changes only')
            changed = list(dict.fromkeys(local))
        results = affected(changed, entries)
    except Exception as exc:  # WHY: a drift report must never break the caller (audit, PR prep).
        print(f"diagrams-check: skipped ({exc})")
        return 0
    if not results:
        print(f"diagrams-check: no diagram watches a path changed since {base}")
        return 0
    for r in results:
        mark = "STALE?  " if r.status == "stale" else "updated "
        more = ", …" if len(r.matches) > 3 else ""
        print(f"{mark} {r.id}  ← {', '.join(r.matches[:3])}{more}")
    stale = sum(r.status == "stale" for r in results)
    print(f"\n{stale} possibly stale. Re-render (make diagrams-render ID=<id>) or justify in the PR. See [[diagrams]].")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd diagrams && ../.venv/bin/python -m pytest tests/test_drift.py -v`
Expected: PASS.

- [x] **Step 5: Switch `diagrams-check` to the Python port**

Replace the recipe line `pnpm --filter @3mrai/diagrams check-drift` with:
```make
	$(VENV)/bin/python -m diagrams3mrai.drift
```
Run: `make diagrams-check`
Expected: exit 0 and a report (entries listed as `STALE?` is expected on this branch).

- [x] **Step 6: Commit (via the menu)**

```bash
git add diagrams/diagrams3mrai/drift.py diagrams/tests/test_drift.py Makefile
git commit -m "build(diagrams): port the drift check to python"
```

---

### Task 3: Icon manifest and gate

**Files:**
- Create: `diagrams/icons.yaml`
- Create: `diagrams/diagrams3mrai/gate.py`
- Create: `diagrams/tests/test_gate.py`
- Create: `diagrams/tests/fixtures/ok.html`
- Modify: `Makefile` (add `diagrams-gate`)

**Interfaces:**
- Consumes: `Entry`, `load_catalog`, `select`, `REPO_ROOT` from Task 1.
- Produces: `ICON_PREFIX = "https://cdn.jsdelivr.net/npm/aws-icons@3.2.0/icons/"`, `ICONS_PATH: Path`, `load_icons(path: Path = ICONS_PATH) -> dict[str, str]` (key → full URL), `image_hrefs(html: str) -> list[str]`, `check_icons(html: str, allowed: set[str]) -> list[str]`, `view_box_width(html: str) -> float | None`, `filter_self_check(errors: list[str]) -> list[str]`, `locate_self_check() -> Path` (raises `GateSetupError`), `check_entry(entry: Entry, allowed: set[str], verify: Callable[[Path], list[str]], root: Path = REPO_ROOT) -> list[str]`, `orphans(entries: list[Entry], root: Path = REPO_ROOT) -> list[str]`, `missing_renders(entries: list[Entry], root: Path = REPO_ROOT) -> list[str]` (entries whose source exists but whose PNG is missing; run only when the gate is called without ids, together with `orphans`), `main(argv: list[str] | None = None) -> int` (`python -m diagrams3mrai.gate [id ...]`; nonzero on any failure). Env: `DIAGRAMS_OFFLINE=1` skips manifest reachability; `DIAGRAM_DESIGN_SELF_CHECK=<path>` overrides the self_check location.

- [x] **Step 1: Create `icons.yaml`**

`diagrams/icons.yaml` (keys are what authors write in prose; values are paths under `ICON_PREFIX`):
```yaml
# Allowlist of AWS Architecture Icons (aws-icons@3.2.0 on jsDelivr) a diagram may reference.
# A diagram's <image href> must be ICON_PREFIX + one of these values; anything else fails make diagrams-gate.
icons:
  api-gateway: architecture-service/AmazonAPIGateway.svg
  aurora: architecture-service/AmazonAurora.svg
  cloudwatch: architecture-service/AmazonCloudWatch.svg
  cognito: architecture-service/AmazonCognito.svg
  documentdb: architecture-service/AmazonDocumentDB.svg
  dynamodb: architecture-service/AmazonDynamoDB.svg
  ecr: architecture-service/AmazonElasticContainerRegistry.svg
  ecs: architecture-service/AmazonElasticContainerService.svg
  elasticache: architecture-service/AmazonElastiCache.svg
  elb: architecture-service/ElasticLoadBalancing.svg
  eventbridge: architecture-service/AmazonEventBridge.svg
  fargate: architecture-service/AWSFargate.svg
  lambda: architecture-service/AWSLambda.svg
  rds: architecture-service/AmazonRDS.svg
  s3: architecture-service/AmazonSimpleStorageService.svg
  secrets-manager: architecture-service/AWSSecretsManager.svg
  ses: architecture-service/AmazonSimpleEmailService.svg
  sns: architecture-service/AmazonSimpleNotificationService.svg
  sqs: architecture-service/AmazonSimpleQueueService.svg
  ssm: architecture-service/AWSSystemsManager.svg
  vpc: architecture-service/AmazonVirtualPrivateCloud.svg
  alb: resource/ElasticLoadBalancingApplicationLoadBalancer.svg
  ecs-service: resource/AmazonElasticContainerServiceService.svg
  ecs-task: resource/AmazonElasticContainerServiceTask.svg
  dynamodb-table: resource/AmazonDynamoDBTable.svg
  client: resource/Client.svg
  data-table: resource/DataTable.svg
  internet: resource/Internet.svg
  office-building: resource/Officebuilding.svg
  server: resource/Server.svg
  user: resource/User.svg
  users: resource/Users.svg
  group-aws-cloud: architecture-group/AWSCloudlogo.svg
  group-region: architecture-group/Region.svg
  group-vpc: architecture-group/VirtualprivatecloudVPC.svg
  group-private-subnet: architecture-group/Privatesubnet.svg
  group-public-subnet: architecture-group/Publicsubnet.svg
```

- [x] **Step 2: Create the passing fixture**

`diagrams/tests/fixtures/ok.html` — a minimal page the real `self_check.py` accepts apart from the allow-listed icon:
```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fixture</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
</head>
<body>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" role="img" aria-labelledby="ok-title ok-desc">
  <title id="ok-title">Fixture</title>
  <desc id="ok-desc">A single Lambda node used to test the diagram gate.</desc>
  <rect width="100%" height="100%" fill="#f5f5f5"/>
  <image href="https://cdn.jsdelivr.net/npm/aws-icons@3.2.0/icons/architecture-service/AWSLambda.svg" x="180" y="80" width="40" height="40"/>
</svg>
</body>
</html>
```

- [x] **Step 3: Write the failing tests**

`diagrams/tests/test_gate.py`:
```python
from pathlib import Path

import pytest

from diagrams3mrai.catalog import Entry
from diagrams3mrai.gate import (
    ICON_PREFIX, check_entry, check_icons, filter_self_check, image_hrefs, load_icons, load_verify, orphans,
    self_check_available, view_box_width,
)

FIX = Path(__file__).parent / "fixtures"
LAMBDA = ICON_PREFIX + "architecture-service/AWSLambda.svg"
ALLOWED = {LAMBDA}


def svg(body: str, width: int = 400) -> str:
    return f'<svg viewBox="0 0 {width} 200" role="img">{body}</svg>'


def test_load_icons_builds_full_urls():
    icons = load_icons()
    assert icons["lambda"] == LAMBDA
    assert all(u.startswith(ICON_PREFIX) and u.endswith(".svg") for u in icons.values())


def test_load_icons_rejects_bad_path(tmp_path):
    p = tmp_path / "icons.yaml"
    p.write_text("icons:\n  x: ../evil.svg\n")
    with pytest.raises(ValueError, match="x"):
        load_icons(p)


def test_image_hrefs_reads_href_and_xlink():
    html = svg(f'<image href="{LAMBDA}"/><image xlink:href="https://x/y.svg"/>')
    assert image_hrefs(html) == [LAMBDA, "https://x/y.svg"]


def test_allowed_icon_passes():
    assert check_icons(svg(f'<image href="{LAMBDA}"/>'), ALLOWED) == []


def test_unpinned_version_fails():
    url = "https://cdn.jsdelivr.net/npm/aws-icons@latest/icons/architecture-service/AWSLambda.svg"
    assert check_icons(svg(f'<image href="{url}"/>'), ALLOWED) == [f"icon not in diagrams/icons.yaml: {url}"]


def test_unlisted_icon_fails():
    url = ICON_PREFIX + "architecture-service/AWSLambdaa.svg"
    assert check_icons(svg(f'<image href="{url}"/>'), ALLOWED) == [f"icon not in diagrams/icons.yaml: {url}"]


def test_prefix_match_alone_is_not_enough():
    # self_check truncates URLs to 80 chars, so the filter cannot tell these apart; check_icons must.
    url = ICON_PREFIX + "resource/NotInTheManifestButSamePrefix.svg"
    errors = [f"remote reference on <image>: {url[:80]}"]
    assert filter_self_check(errors) == []
    assert check_icons(svg(f'<image href="{url}"/>'), ALLOWED) != []


def test_filter_keeps_every_other_error():
    errors = [
        f"remote reference on <image>: {LAMBDA[:80]}",
        "remote reference on <image>: https://example.com/x.svg",
        "remote reference on <script>: " + ICON_PREFIX,
        "svg 1 needs role=img",
    ]
    assert filter_self_check(errors) == errors[1:]


def test_view_box_width():
    assert view_box_width(svg("", 1996)) == 1996
    assert view_box_width("<p>no svg</p>") is None


def entry(tmp_path: Path, html: str | None, id_: str = "ok") -> Entry:
    src = f"diagrams/src/flows/{id_}.html"
    if html is not None:
        (tmp_path / "diagrams/src/flows").mkdir(parents=True, exist_ok=True)
        (tmp_path / src).write_text(html)
    return Entry(id_, "Ok", src, f"docs/x/{id_}", ())


def no_errors(_: Path) -> list[str]:
    return []


def test_check_entry_ok(tmp_path):
    e = entry(tmp_path, (FIX / "ok.html").read_text())
    assert check_entry(e, ALLOWED, no_errors, tmp_path) == []


def test_missing_src_fails(tmp_path):
    e = entry(tmp_path, None)
    assert check_entry(e, ALLOWED, no_errors, tmp_path) == ["ok: missing source diagrams/src/flows/ok.html"]


def test_too_wide_fails(tmp_path):
    e = entry(tmp_path, svg("", 2004))
    assert "ok: viewBox width 2004 exceeds 2000" in check_entry(e, ALLOWED, no_errors, tmp_path)


def test_self_check_errors_are_filtered_and_prefixed(tmp_path):
    e = entry(tmp_path, (FIX / "ok.html").read_text())
    verify = lambda _: [f"remote reference on <image>: {LAMBDA[:80]}", "svg 1 needs role=img"]
    assert check_entry(e, ALLOWED, verify, tmp_path) == ["ok: svg 1 needs role=img"]


def test_orphan_html_fails(tmp_path):
    e = entry(tmp_path, svg(""))
    (tmp_path / "diagrams/src/flows/stray.html").write_text(svg(""))
    assert orphans([e], tmp_path) == ["diagrams/src/flows/stray.html has no catalog entry"]


@pytest.mark.skipif(not self_check_available(), reason="diagram-design plugin not installed")
def test_real_self_check_accepts_fixture_after_filter():
    assert filter_self_check(load_verify()(FIX / "ok.html")) == []
```

- [x] **Step 4: Run tests to verify they fail**

Run: `cd diagrams && ../.venv/bin/python -m pytest tests/test_gate.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'diagrams3mrai.gate'`.

- [x] **Step 5: Implement `gate.py`**

`diagrams/diagrams3mrai/gate.py`:
```python
"""Fail-closed checks for diagram-design sources: skill self_check, icon allowlist, width cap, catalog parity."""

import importlib.util
import os
import re
import sys
import urllib.request
from collections.abc import Callable
from html.parser import HTMLParser
from pathlib import Path

import yaml

from diagrams3mrai.catalog import REPO_ROOT, Entry, load_catalog, select

ICON_PREFIX = "https://cdn.jsdelivr.net/npm/aws-icons@3.2.0/icons/"
ICONS_PATH = REPO_ROOT / "diagrams" / "icons.yaml"
MAX_WIDTH = 2000
SELF_CHECK_DEFAULT = Path.home() / (
    ".claude/plugins/cache/diagram-design/diagram-design/2.6.6/skills/diagram-design/scripts/self_check.py"
)
# CONTRACT: self_check truncates URLs to 80 chars; this filter only drops the error, check_icons validates the full URL.
_TOLERATED = "remote reference on <image>: " + ICON_PREFIX
_ICON_PATH = re.compile(r"(architecture-service|architecture-group|resource|category)/[A-Za-z0-9]+\.svg")


class GateSetupError(RuntimeError):
    pass


def load_icons(path: Path = ICONS_PATH) -> dict[str, str]:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))["icons"]
    for key, rel in raw.items():
        if not _ICON_PATH.fullmatch(rel):
            raise ValueError(f"icons.yaml {key}: invalid path {rel}")
    return {key: ICON_PREFIX + rel for key, rel in raw.items()}


class _Images(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.hrefs: list[str] = []
        self.view_box: str | None = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "image":
            href = a.get("href") or a.get("xlink:href")
            if href:
                self.hrefs.append(href)
        elif tag == "svg" and self.view_box is None:
            self.view_box = a.get("viewbox")


def _parse(html: str) -> _Images:
    p = _Images()
    p.feed(html)
    return p


def image_hrefs(html: str) -> list[str]:
    return _parse(html).hrefs


def check_icons(html: str, allowed: set[str]) -> list[str]:
    return [f"icon not in diagrams/icons.yaml: {h}" for h in image_hrefs(html) if h not in allowed]


def view_box_width(html: str) -> float | None:
    vb = _parse(html).view_box
    return float(vb.replace(",", " ").split()[2]) if vb else None


def filter_self_check(errors: list[str]) -> list[str]:
    return [e for e in errors if not e.startswith(_TOLERATED)]


def locate_self_check() -> Path:
    path = Path(os.environ.get("DIAGRAM_DESIGN_SELF_CHECK", SELF_CHECK_DEFAULT))
    if not path.is_file():
        raise GateSetupError(
            f"diagram-design self_check.py not found at {path}. Install the diagram-design plugin v2.6.6 "
            "(see diagrams/CLAUDE.md) or set DIAGRAM_DESIGN_SELF_CHECK."
        )
    return path


def self_check_available() -> bool:
    try:
        locate_self_check()
        return True
    except GateSetupError:
        return False


def load_verify() -> Callable[[Path], list[str]]:
    spec = importlib.util.spec_from_file_location("diagram_design_self_check", locate_self_check())
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.verify


def check_entry(entry: Entry, allowed: set[str], verify: Callable[[Path], list[str]], root: Path = REPO_ROOT) -> list[str]:
    src = root / entry.src
    if not src.is_file():
        return [f"{entry.id}: missing source {entry.src}"]
    html = src.read_text(encoding="utf-8")
    errors = [*filter_self_check(verify(src)), *check_icons(html, allowed)]
    width = view_box_width(html)
    if width is None:
        errors.append("no <svg viewBox>")
    elif width > MAX_WIDTH:
        errors.append(f"viewBox width {width:g} exceeds {MAX_WIDTH}")
    return [f"{entry.id}: {e}" for e in errors]


def orphans(entries: list[Entry], root: Path = REPO_ROOT) -> list[str]:
    known = {e.src for e in entries}
    found = sorted(p.relative_to(root).as_posix() for p in (root / "diagrams/src").glob("*/*.html"))
    return [f"{p} has no catalog entry" for p in found if p not in known]


def unreachable(urls: list[str]) -> list[str]:
    bad = []
    for url in urls:
        try:
            with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=10) as r:
                if r.status != 200:
                    bad.append(f"icon URL answered {r.status}: {url}")
        except Exception as exc:
            bad.append(f"icon URL unreachable ({exc}): {url}")
    return bad


def main(argv: list[str] | None = None) -> int:
    ids = list(sys.argv[1:] if argv is None else argv)
    try:
        entries = load_catalog()
        chosen = select(entries, ids)
        icons = load_icons()
        verify = load_verify()
    except (GateSetupError, KeyError, ValueError) as exc:
        print(f"diagrams-gate: {exc}")
        return 1
    errors = [] if ids else orphans(entries)
    if os.environ.get("DIAGRAMS_OFFLINE") != "1":
        errors += unreachable(sorted(set(icons.values())))
    allowed = set(icons.values())
    for e in chosen:
        errs = check_entry(e, allowed, verify)
        print(("FAIL " if errs else "OK   ") + e.id)
        errors += errs
    for line in errors:
        print(f"  - {line}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [x] **Step 6: Run tests to verify they pass**

Run: `cd diagrams && ../.venv/bin/python -m pytest tests/test_gate.py -v`
Expected: PASS (the real-self_check test runs when the plugin is installed; it must pass, proving the fixture contract).

- [x] **Step 7: Add `diagrams-gate` and verify the manifest is reachable**

Add to `.PHONY` and the Makefile:
```make
diagrams-gate: ## Fail on any diagram-design source that breaks the skill self_check, icon allowlist, 2000px cap or catalog parity (all, or ID=a,b)
	$(VENV)/bin/python -m diagrams3mrai.gate $(subst $(comma), ,$(ID))
```
Run: `.venv/bin/python -c "from diagrams3mrai.gate import load_icons, unreachable; print(unreachable(sorted(load_icons().values())))"`
Expected: `[]` (every manifest URL answers 200). Fix any wrong path in `icons.yaml` before continuing.

- [x] **Step 8: Commit (via the menu)**

```bash
git add diagrams/icons.yaml diagrams/diagrams3mrai/gate.py diagrams/tests/test_gate.py diagrams/tests/fixtures/ok.html Makefile
git commit -m "build(diagrams): gate diagram-design sources with an aws-icons allowlist"
```

---

### Task 4: PNG render and make targets

**Files:**
- Create: `diagrams/diagrams3mrai/render.py`
- Create: `diagrams/tests/test_render.py`
- Create: `diagrams/tests/fixtures/missing-icon.html`
- Modify: `Makefile` (`diagrams-render`, `diagrams-studio`)

**Interfaces:**
- Consumes: `Entry`, `load_catalog`, `select`, `REPO_ROOT` (Task 1); `gate.main` (Task 3).
- Produces: `render_png(src: Path, out: Path, scale: int = 2) -> None` (raises `RenderError` on any failed/≥400 jsDelivr request or a motion root not in `data-frame="static"`), `render_png` pins the SVG to its viewBox size before the screenshot, so the PNG is viewBox width × scale (`test_png_width_is_view_box_width_times_scale`), `main(argv: list[str] | None = None) -> int` (`python -m diagrams3mrai.render [id ...]`: runs the gate for the same ids first, then renders each entry to `entry.png`, warns over 2 MB).

- [x] **Step 1: Create the failing fixture**

`diagrams/tests/fixtures/missing-icon.html`: copy `ok.html` and change the icon href to `https://cdn.jsdelivr.net/npm/aws-icons@3.2.0/icons/architecture-service/DoesNotExist.svg`.

- [x] **Step 2: Write the failing tests**

`diagrams/tests/test_render.py`:
```python
import os
from pathlib import Path

import pytest

from diagrams3mrai.render import RenderError, render_png

FIX = Path(__file__).parent / "fixtures"
pytestmark = pytest.mark.skipif(os.environ.get("DIAGRAMS_OFFLINE") == "1", reason="needs network for jsDelivr icons")


def test_render_writes_png(tmp_path):
    out = tmp_path / "ok.png"
    render_png(FIX / "ok.html", out)
    assert out.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_render_fails_on_missing_icon(tmp_path):
    with pytest.raises(RenderError, match="DoesNotExist.svg"):
        render_png(FIX / "missing-icon.html", tmp_path / "x.png")


def test_render_static_frame(tmp_path):
    html = (FIX / "ok.html").read_text().replace(
        "<svg ", '<div data-motion-root data-frame="step-2"></div><svg ', 1
    )
    src = tmp_path / "motion.html"
    src.write_text(html)
    with pytest.raises(RenderError, match="data-frame"):
        render_png(src, tmp_path / "m.png")
```

- [x] **Step 3: Run tests to verify they fail**

Run: `cd diagrams && ../.venv/bin/python -m pytest tests/test_render.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'diagrams3mrai.render'`.

- [x] **Step 4: Implement `render.py`**

`diagrams/diagrams3mrai/render.py`:
```python
"""Render diagram-design sources to PNG beside their vault notes (static frame, opaque paper background)."""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from diagrams3mrai import gate
from diagrams3mrai.catalog import REPO_ROOT, load_catalog, select

MAX_BYTES = 2 * 1024 * 1024


class RenderError(RuntimeError):
    pass


def render_png(src: Path, out: Path, scale: int = 2) -> None:
    failures: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(device_scale_factor=scale)
        page.on("requestfailed", lambda r: failures.append(f"{r.url} ({r.failure})"))
        page.on("response", lambda r: r.status >= 400 and failures.append(f"{r.url} (HTTP {r.status})"))
        page.goto(f"{src.resolve().as_uri()}?motion=static")
        page.wait_for_load_state("networkidle")
        page.evaluate("document.fonts.ready.then(() => true)")
        frame = page.evaluate("document.querySelector('[data-motion-root]')?.getAttribute('data-frame') ?? null")
        if frame not in (None, "static"):
            browser.close()
            raise RenderError(f"{src}: motion root has data-frame={frame!r}, expected 'static'")
        if failures:
            browser.close()
            raise RenderError(f"{src}: failed requests: {'; '.join(failures)}")
        out.parent.mkdir(parents=True, exist_ok=True)
        # WHY: opaque paper background — a transparent PNG with dark ink is unreadable in Obsidian's dark theme.
        page.locator("svg").first.screenshot(path=str(out), omit_background=False)
        browser.close()


def main(argv: list[str] | None = None) -> int:
    ids = list(sys.argv[1:] if argv is None else argv)
    if gate.main(ids) != 0:
        print("diagrams-render: gate failed; nothing rendered")
        return 1
    failed = 0
    for e in select(load_catalog(), ids):
        out = REPO_ROOT / e.png
        try:
            render_png(REPO_ROOT / e.src, out)
        except RenderError as exc:
            print(f"FAIL {e.id}: {exc}")
            failed += 1
            continue
        size = out.stat().st_size
        warn = f"  (warning: {size / 1048576:.1f} MB > 2 MB)" if size > MAX_BYTES else ""
        print(f"OK   {e.id} → {e.png}{warn}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
```

The shipped `render.py` also pins the SVG to its viewBox size via `_PIN_SVG_SIZE`; see the Task 4 Interfaces line.

- [x] **Step 5: Run tests to verify they pass**

Run: `cd diagrams && ../.venv/bin/python -m pytest -v`
Expected: PASS for the whole suite (catalog, drift, gate, render).

- [x] **Step 6: Switch the make targets**

Replace the `diagrams-render` and `diagrams-studio` recipes:
```make
diagrams-render: ## Gate then render diagram-design sources to PNG in the vault (all, or ID=a,b); warns over 2 MB
	$(VENV)/bin/python -m diagrams3mrai.render $(subst $(comma), ,$(ID))

diagrams-studio: ## Open one diagram's interactive HTML in the browser (ID=<id> required)
	@test -n "$(ID)" || { echo "usage: make diagrams-studio ID=<id>"; exit 1; }
	open "diagrams/src/$$(.venv/bin/python -c "from diagrams3mrai.catalog import load_catalog, select; print(select(load_catalog(), ['$(ID)'])[0].src.removeprefix('diagrams/src/'))")"
```
Run: `make diagrams-render ID=typo`
Expected: exit 1 with `unknown diagram id(s): typo`.

- [x] **Step 7: Commit (via the menu)**

```bash
git add diagrams/diagrams3mrai/render.py diagrams/tests/test_render.py diagrams/tests/fixtures/missing-icon.html Makefile
git commit -m "build(diagrams): render diagram-design sources to png with playwright"
```

---

### Task 5: Agent and package guidance

**Files:**
- Modify: `diagrams/CLAUDE.md` (full rewrite)
- Modify: `.claude/agents/diagram-impl.md` (full rewrite of body; keep frontmatter `name`, update `description` and `tools`)

**Interfaces:**
- Consumes: catalog/icons/gate/render contracts from Tasks 1–4.
- Produces: the authoring contract `diagram-impl` follows in Tasks 6–8.

- [x] **Step 1: Rewrite `diagrams/CLAUDE.md`** with these sections (English, ≤150 lines):
  - **What lives here:** `catalog.yaml`, `icons.yaml`, `src/<group>/<id>.html`, `diagrams3mrai/` (catalog, drift, gate, render), `tests/`. Convention [[diagrams]], decision ADR-0024 (once written).
  - **Prerequisites:** the `diagram-design` plugin v2.6.6 installed (Claude Code `/plugin`; Codex has its own manifest); `make diagrams-setup` once per clone.
  - **Authoring contract:** load the `diagram-design:diagram-design` skill; read the type reference (`type-architecture`, `type-flowchart`/`type-sequence`/`type-process` for flows, `type-dependency` for milestones); copy `assets/template.html` (static) or `assets/template-motion.html` (flows, `data-motion-mode="step"`, controller verbatim); 4px grid; connector rules §6; accessible SVG contract with `<id>-title` / `<id>-desc`.
  - **Icons:** `<image href="{ICON_PREFIX}{path}" width="40" height="40">` with the node label below; only keys of `icons.yaml`; add a key there (and verify HTTP 200) before using a new icon. Non-AWS things (Stripe, Geoapify, OpenObserve, browser) use `client`/`server`/`internet`/`users` icons or a plain skill node box.
  - **Budget and coverage:** default ≤9 nodes; `faithful` ≤24, zoned above 9; ≤3 zones; every runtime AWS service gets a node; split into views rather than exceed 24. Zones replace AWS group frames (VPC zone whose label names AZs/subnets).
  - **Flows:** numbered step badges inside the SVG (complete static meaning), `step` mode for the interactive HTML, ≤8 motion steps.
  - **Commands:** `make diagrams-gate [ID=]`, `make diagrams-render [ID=]`, `make diagrams-check`, `make diagrams-studio ID=`; `DIAGRAMS_OFFLINE=1` skips icon reachability.
  - **Never:** GIFs; unpinned icon versions; edits to `.md` under `docs/`; git or Linear.

- [x] **Step 2: Rewrite `.claude/agents/diagram-impl.md`**

Frontmatter `description`: "Diagram implementer for the 3MRAI diagram-design sources (diagrams/). Use to add, update or re-render an architecture, flow or milestone diagram. Loads the diagram-design skill, reads the real code and Terraform before drawing, edits only diagrams/** and the rendered docs/**/diagrams/*.png, never touches .md notes, git or Linear, and leaves the work in the working tree for the main session to commit." Tools: `Read, Write, Edit, Bash, Glob, Grep, Skill`. Body: read `diagrams/CLAUDE.md` first; per diagram — read sources named in its `watches`, plan nodes/edges against the budget, author HTML, `make diagrams-render ID=<id>`, view the PNG with Read, iterate until the skill's §9 checklist passes; report a coverage table (AWS services drawn vs. the Remotion view it replaces, when one exists) and any embed changes needed for `obsidian-vault`.

- [x] **Step 3: Verify**

Run: `make lint-comments` → exit 0. `grep -n -i remotion diagrams/CLAUDE.md .claude/agents/diagram-impl.md` → no output.

- [x] **Step 4: Commit (via the menu)**

```bash
git add diagrams/CLAUDE.md .claude/agents/diagram-impl.md
git commit -m "docs(agents): point diagram-impl at the diagram-design toolchain"
```

---

### Task 6: Pilot — one diagram per kind (STOP POINT)

**Files:**
- Create: `diagrams/src/architecture/architecture-dev-floci-events.html`
- Create: `diagrams/src/flows/orders-checkout-stripe.html`
- Create: `diagrams/src/system-context/system-context-l1.html`
- Create: `diagrams/src/milestones/milestone-users-service-deps.html`
- Modify (re-rendered): the four matching `docs/**/diagrams/<id>.png`

**Interfaces:**
- Consumes: Task 5 authoring contract; the Remotion data modules `diagrams/src/data/<group>/*.ts` as the content inventory (nodes, edges, steps) to carry over.

- [x] **Step 1: Dispatch `diagram-impl`** (one agent, English brief) for the four ids above. Brief must include: the Global Constraints of this plan; "carry over every node, edge and step of the Remotion data module — do not add or drop content; if the budget forces zoning or a cut, report it instead of deciding"; render each with `make diagrams-render ID=<id>`; no git.
- [x] **Step 2: Gate.** Run `make diagrams-gate ID=architecture-dev-floci-events,orders-checkout-stripe,system-context-l1,milestone-users-service-deps` → all `OK`.
- [x] **Step 3: Coverage parity.** For each pilot id, list the AWS icons in the old TS module (`grep -oE 'icon: *"[a-z-]+"'`) and the `<image href>` keys in the new HTML; every runtime AWS service of the old view is present, or the difference is listed for the user.
- [x] **Step 4: Visual check.** Read each PNG; confirm entry on the left, orthogonal connectors, no label on its own stroke, numbered badges on the flow, width ≤2000. Open `orders-checkout-stripe.html` with `make diagrams-studio ID=orders-checkout-stripe` and step through it.
- [x] **Step 5: Audit.** Run the `spec-implementation-audit` skill against the spec for Tasks 1–6.
- [x] **Step 6: Commit (via the menu)** — `feat(diagrams): pilot the diagram-design style on one diagram per kind`.
- [x] **Step 7: STOP.** Present the four PNGs, the parity table and audit findings to the user. Do not start Task 7 until the user approves the style and icons (changes requested → revise Task 5 guidance and the pilot first).

---

### Task 7: Migrate architecture and system-context views

**Files:**
- Create: `diagrams/src/architecture/{architecture-dev-floci,architecture-preprod,architecture-preprod-events}.html`
- Create: `diagrams/src/system-context/{system-context-l2,system-context-l2-events}.html`
- Modify (re-rendered): matching PNGs under `docs/00-overview/diagrams/`

- [x] **Step 1: Dispatch `diagram-impl`** for the five ids, with the same brief as Task 6 Step 1 plus "match the approved pilot's layout conventions".
- [x] **Step 2: Gate** `make diagrams-gate ID=architecture-dev-floci,architecture-preprod,architecture-preprod-events,system-context-l2,system-context-l2-events` → all OK.
- [x] **Step 3: Coverage parity** as Task 6 Step 3 for each id; any gap goes to the user before commit.
- [x] **Step 4: Visual check** of each PNG as Task 6 Step 4.
- [x] **Step 5: Commit (via the menu)** — `feat(diagrams): migrate the architecture and system-context views to diagram-design`.

---

### Task 8: Migrate flows and milestone graphs

**Files:**
- Create: `diagrams/src/flows/<id>.html` for the 18 remaining flows: `users-signup-otp`, `users-password-reset`, `tracking-notification`, `observability-telemetry`, `tracking-outbox-relay`, `events-pipeline-fanout-dlq`, `websocket-lifecycle`, `auth-passwordless-otp-signin`, `auth-password-signin-refresh`, `users-cognito-identity-webhook`, `users-account-deletion-cascade`, `orders-catalogue-cart`, `response-cache`, `checkout-address-geocoding-proxy`, `business-metrics`, `browser-rum`, `preprod-deploy`, `terraform-two-phase-apply`
- Create: `diagrams/src/milestones/{milestone-services-infra-scaffold-deps,milestone-documentation-vault-deps}.html`
- Modify (re-rendered): matching PNGs

- [x] **Step 1: Dispatch `diagram-impl` in three sequential batches** (one agent each, to keep briefs small): (a) the first 7 flows listed, (b) the next 7, (c) the last 4 flows + 2 milestones. Same brief as Task 7 Step 1. Flows: `step` mode, numbered badges, ≤8 motion steps (if the Remotion flow had 9–10 steps, merge adjacent steps and report the merge).
- [x] **Step 2: After each batch** run `make diagrams-gate ID=<batch ids>` and view each PNG.
- [x] **Step 3: Coverage parity** for every id.
- [x] **Step 4: Full gate** `make diagrams-gate` (no ID) → all 29 OK, no orphans.
- [x] **Step 5: Commit (via the menu)** — `feat(diagrams): migrate every flow and milestone graph to diagram-design`.

---

### Task 9: Retire Remotion and switch embeds to PNG

**Files:**
- Delete: `diagrams/src/{aws,theme,data,scripts}/`, `diagrams/src/{catalog.ts,index.ts,Root.tsx,schema.ts}`, `diagrams/test/`, `diagrams/public/`, `diagrams/out/`, `diagrams/scripts/` (`fetch_aws_icons.py`, its test, `__pycache__`), `diagrams/{package.json,tsconfig.json,vitest.config.ts,remotion.config.ts}`, `diagrams/node_modules/`
- Delete: `.claude/skills/remotion-*` and `.ai/skills/remotion-*` (12 each)
- Delete: every `docs/**/diagrams/*.gif`
- Modify: `pnpm-workspace.yaml` (remove `- "diagrams"`), `pnpm-lock.yaml` (via `pnpm install`), `Makefile` (remove `diagrams-icons` target and `.PHONY` entry), `.gitignore` (drop Remotion-only entries such as `diagrams/out`)
- Modify (via `obsidian-vault`): every vault note embedding `![[<id>.gif]]` → `![[<id>.png]]`

- [x] **Step 1: Switch embeds first** — dispatch `obsidian-vault` (English): replace every `.gif` embed/link of a catalog output with its `.png`, bump `updated:`; list the notes touched. Then `nvm use && node scripts/validate-vault.mjs` → green.
- [x] **Step 2: Delete** the files listed above (`git rm -r` for tracked paths; `rm -rf` for `node_modules`, `out`, `__pycache__`).
- [x] **Step 3: Workspace** — remove `"diagrams"` from `pnpm-workspace.yaml`; `nvm use && pnpm install` → lockfile updated, exit 0. Remove the `diagrams-icons` target.
- [x] **Step 4: Sync providers** — `make ai-sync` then `make ai-sync-check` → green; `grep -rli remotion .ai .claude AGENTS.md` lists nothing but vault-history notes.
- [x] **Step 5: Verify** — `find docs -name '*.gif' -path '*diagrams*'` → empty; `node scripts/validate-vault.mjs` → green; `make diagrams-gate` → 29 OK; `cd diagrams && ../.venv/bin/python -m pytest` → PASS.
- [x] **Step 6: Commit (via the menu)** — `refactor(diagrams)!: retire remotion in favour of diagram-design` with a `BREAKING CHANGE:` footer naming the removed targets/scripts (`diagrams-icons`, `pnpm --filter @3mrai/diagrams *`).

---

### Task 10: Vault and rules propagation

**Files:**
- Create (via `obsidian-vault`): `docs/shared/decisions/ADR-0024-diagram-design-diagrams.md`
- Modify (via `obsidian-vault`): `docs/shared/decisions/ADR-0023-remotion-diagrams.md` (status superseded, link to ADR-0024), `docs/shared/conventions/diagrams.md`, `docs/shared/conventions/git-workflow.md`, `docs/lessons/diagram-legibility.md`, `docs/00-overview/architecture.md`, `docs/00-overview/system-context.md`, the remaining notes that mention Remotion (list via `grep -rli remotion docs | grep -v superpowers`), the spec (add `[[ADR-0024-diagram-design-diagrams]]` to `propagates-to`, status `active`), and this plan's index entry in `docs/plans/index.md`
- Modify: root `CLAUDE.md` (*Diagrams* section and the `diagram-impl` line under *Subagents*), then `make ai-sync`

- [x] **Step 1: Dispatch `obsidian-vault`** (English brief) with: ADR-0024 content (context: Remotion → diagram-design; decisions 1–6 of the spec; consequences: no GIF, no AWS group frames, CDN dependency pinned to aws-icons@3.2.0, plugin prerequisite); `diagrams` convention rewrite keeping keep-current, coverage and PR `## Diagrams` (PNG) rules and documenting the make targets; `git-workflow` GIF→PNG; `diagram-legibility` trimmed of ELK/Remotion specifics; other notes' Remotion mentions updated to diagram-design; bidirectional `## Related` links; `updated: <today>`.
- [x] **Step 2: Edit root `CLAUDE.md`** *Diagrams* section to:
  ```markdown
  ### Diagrams
  - Diagrams are hand-authored `diagram-design` HTML sources in `diagrams/src/`, rendered to PNG beside their vault notes; no GIFs.
  - A change to a diagrammed flow or an AWS resource re-renders the affected diagram in the same PR.
  - Run `make diagrams-gate` and `make diagrams-check` before proposing a PR; every `STALE?` line is fixed or justified.
  - Attach the PNG under `## Diagrams` in the PR body when a flow is new or affected.
  - Full convention: `docs/shared/conventions/diagrams.md` → [[diagrams]]. Work goes through `diagram-impl`.
  ```
  and the `diagram-impl` bullet under *Subagents* to say "the diagram-design sources in `diagrams/`" and "`docs/**/diagrams/*.png`".
- [x] **Step 3: Sync and validate** — `make ai-sync && make ai-sync-check`; `nvm use && node scripts/validate-vault.mjs` → green; `make lint-comments` → green.
- [x] **Step 4: Commit (via the menu)** — `docs(vault): record the diagram-design decision and propagate it`.

---

### Task 11: Close

- [x] **Step 1:** Run the `spec-implementation-audit` skill (spec → code, code → docs, plan → repo). Every gap found is fixed in its own change before continuing; re-run until clean.
- [x] **Step 2:** `make diagrams-gate`, `make diagrams-check`, `cd diagrams && ../.venv/bin/python -m pytest`, `nvm use && node scripts/validate-vault.mjs`, `make lint-comments` — all green; paste outputs into the handoff.
- [x] **Step 3:** Update PR #130's title/body (`gh pr edit 130`) to describe the diagram-design migration, with `## Diagrams` (pilot PNGs), `## References` (spec, plan, ADR-0024) — via the menu (option for push + PR edit). Never merge.

## Execution notes

- Task 3 gap closed at the Task 6 stop point: the spec requires catalog ↔ sources ↔ PNG parity; the gate checks PNG existence via `missing_renders` (tests `test_missing_png_fails`, `test_missing_png_is_not_reported_before_the_source_exists`).
- `.claude/settings.json` enables `diagram-design@diagram-design` and declares the `cathrynlavery/diagram-design` marketplace; the installed plugin is v2.6.6 while upstream is v2.6.98 (not pinned by the setting).
- `diagram-impl` keeps two transitional Remotion mentions until Task 10.
- Tasks 7–8 run one `diagram-impl` per diagram in parallel waves (5, then 7/7/6) instead of sequential batch agents.
- The gate also runs the plugin's `verify-geometry.py` (user decision at the pilot stop point) and, for a flow with a motion root, `verify-motion.py` (tests `test_real_verify_runs_verify_motion_on_a_motion_root`, `test_real_verify_skips_verify_motion_on_a_static_diagram`).
- Approved pilot conventions and later rulings (ECS cluster may be a zone when edges target it; no routes in labels even when carrying content over 1:1) live in `diagrams/CLAUDE.md`.
- Flows carry Remotion content over 1:1 except merged adjacent steps (≤8 motion steps). Content gaps found against the code (pre-existing in the Remotion versions) are listed for follow-up, not drawn: tracking-outbox-relay (notifications queue), websocket-lifecycle ($default Lambda, Sockets query), users-password-reset (CloudWatch metric), auth flows (API Gateway / nginx hop), users-account-deletion-cascade (Orders/Tracking cache invalidation), preprod-deploy (integration decisions, lambda bundles), terraform-two-phase-apply (app-user secrets).

- Task 9 removes the Remotion package, its 12 skills (and their provider links via `make ai-sync`), the local icons and the 19 GIFs; embeds switch to PNG first so the validator stays green.
- Task 10 records ADR-0024 (superseding ADR-0023), rewrites the `diagrams` convention and the `diagram-legibility` lesson, and replaces Remotion mentions across the vault; historical mentions (superseded ADRs, dated plans) stay.
- Task 11: the audit aligned the spec with the shipped gate and zone conventions; the whole-branch review found no Critical issues and three Important ones (newest plugin install, setup guard on every `diagrams-*` target, stale `skills-lock.json` entries), all fixed; minor gate-hardening findings are listed as follow-ups in PR #130.

## Related

- [[2026-10-13-diagram-design-migration-design]]
- [[diagrams]]
- [[ADR-0023-remotion-diagrams]]
- [[ADR-0024-diagram-design-diagrams]]
- [[git-workflow]]
