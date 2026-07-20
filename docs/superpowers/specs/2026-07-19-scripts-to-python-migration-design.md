---
title: Scripts-to-Python Migration Design
type: spec
area: infra
status: draft
created: 2026-07-19
updated: 2026-07-19
tags:
  - type/spec
  - area/infra
  - status/draft
related:
  - "[[2026-07-15-two-phase-post-effects-design]]"
  - "[[awscli-fallback-for-floci]]"
  - "[[testing]]"
---

# Scripts-to-Python Migration Design

## Summary

Migrate the repo's 5 remaining bash scripts to Python, and establish a durable
`scripting-language` convention: future scripts are **Python first, JavaScript second, Bash
only with a documented limitation**. This is **block 1 of 3** of a "Developer Experience"
milestone — the other two blocks (structured logging/tracing for local dev, and env-file
auto-generation) are out of scope here and will each get their own design spec later.

## Goal

- Replace all `.sh` scripts still in the repo with Python equivalents, colocated with the
  Terraform modules that invoke them.
- Ship a shared Python package (`lib3mrai`) that removes duplication those scripts already
  carry (AWS endpoint/credential defaulting, colored console output).
- Write down the language decision tree — Python / JavaScript / Bash — as a vault convention
  so future scripts default the right way without re-litigating it.
- Preserve every script's external interface (CLI args, stdout contract, exit codes, env vars,
  state-file shape) exactly, since Terraform `local-exec` blocks and the Makefile depend on it.

## Non-Goals

- No change to the 3 existing `.mjs` scripts (`scripts/validate-vault.mjs`, `drawio-to-svg.mjs`,
  `import-dashboards.mjs`) — they stay JavaScript. This spec records why, it doesn't touch them.
- No new HTTP endpoints and no application source-code changes — this is infra tooling only.
  Per [[testing]], the three test layers are unaffected; the acceptance check here is the
  existing local bring-up E2E cycle, used as a regression check, not a new test layer.
- No migration of the dead `bootstrap_app_db_user` / `bootstrap_orders_app_db_user` bash
  functions — they are deleted, not ported (see Decision 6).
- Writing the convention note (`docs/shared/conventions/scripting-language.md`) itself, and
  wiring it into the root/`infra/CLAUDE.md` — those are implementation-time deliverables, not
  part of this design spec.

## Current State (verified 2026-07-19)

Five `.sh` files remain in the repo:

| Script | Lines | Role | Invoked by |
|---|---|---|---|
| `infra/environments/local/bootstrap.sh` | 269 | Orchestrator: Docker + SQL + colored output | `make bootstrap` |
| `infra/environments/local/scripts/discover-db-port.sh` | 48 | Wraps `aws rds describe-db-clusters`, echoes a port | Makefile (`DISCOVER_DB_PORT`) + `bootstrap.sh` |
| `infra/environments/local/post/scripts/wait-for-db.sh` | 30 | Polls a DB via throwaway `docker run` | `infra/environments/local/post/gate.tf` |
| `infra/modules/cognito/scripts/create-user-pool-client.sh` | 69 | AWS CLI + embedded `python3 -c` JSON parsing | `infra/modules/cognito/main.tf:102` |
| `infra/modules/cognito/scripts/set-pre-token-trigger.sh` | 119 | ~90% Python inside a `python3 <<'PY'` heredoc | `infra/modules/cognito/main.tf:174` |

Key observation motivating the migration: **two of the five already ARE Python wearing a bash
costume**, precisely because bash could not parse JSON. All three Terraform call sites currently
pin `interpreter = ["/usr/bin/env", "bash"]` (`gate.tf:21`, `cognito/main.tf:103`,
`cognito/main.tf:175`). `.gitignore` currently has nothing Python-related.

`bootstrap.sh`'s own comments state the `bootstrap_app_db_user` / `bootstrap_orders_app_db_user`
functions are **no longer invoked** — replaced by the phase-2 post-effects Terraform apply
(`make infra-up-post`, see [[2026-07-15-two-phase-post-effects-design]], which also documents
why MySQL app-user creation stays gated off locally — Floci's MySQL provider hangs). Only the
nginx-stable Docker DNS alias step is live.

## Decisions

1. **Runtime: venv + `requirements.txt`.** A `.venv/` at repo root, dependencies pinned. Not
   stdlib-only (boto3 is required, see Decision 5), not uv — venv/pip is the ecosystem-default
   choice here and needs no new tool.
2. **Location: unchanged.** Each script stays colocated with its Terraform module; only the
   extension/name changes (kebab-case `.sh` to snake_case `.py`).
3. **The 3 existing `.mjs` scripts stay JavaScript.** They live in the Node ecosystem already
   present in the repo (pnpm workspace, `.nvmrc`) — `validate-vault.mjs`,
   `drawio-to-svg.mjs`, and `import-dashboards.mjs` have no reason to leave it. This is the
   concrete case the convention's "JavaScript second" tier exists to cover.
4. **Terraform invocation: absolute path to the venv interpreter.** The three `local-exec`
   blocks change `interpreter` to the venv's python (e.g. `${path.root}/../../.venv/bin/python`).
   No activation, no PATH reliance. Rationale: the developer's ambient `python3` may already
   resolve into an unrelated venv (verified: resolves to `~/.venvs/release-env/bin/python3` on
   at least one dev machine), so depending on PATH is fragile — a Terraform apply must not
   silently pick up a stray interpreter.
5. **AWS access: boto3**, replacing `subprocess` calls to the `aws` CLI. Honors
   `AWS_ENDPOINT_URL` for Floci exactly as the CLI does today. Eliminates fragile
   `--query`/`--output text` parsing and the `"None"`-literal string check that currently
   substitutes for a real null check. `docker` remains a `subprocess` call — not worth pulling
   in the Docker SDK for roughly 4 invocations total.
6. **`bootstrap.sh`: migrate only the live code.** Port only the nginx-stable Docker DNS alias
   step (~90 effective lines). Delete the two dead app-DB-user functions outright; their
   rationale (provider chicken-and-egg, Floci MySQL user-management limits — see
   [[2026-07-15-two-phase-post-effects-design]]) is preserved in the vault, not carried forward
   as dead code.
7. **Shared package, colocated scripts (option A).** One installable package holds the common
   pieces; the scripts themselves stay next to their Terraform modules rather than moving into
   the package (rejected: centralizing the scripts too would break the "colocated with its
   module" property scripts have today, per Decision 2).

## Target Structure

```
infra/scripts/
├── pyproject.toml            # deps: boto3
├── requirements.txt          # pinned
└── lib3mrai/
    ├── aws.py                # boto3 client factory honoring AWS_ENDPOINT_URL
    ├── console.py            # ok()/no()/inf() colored helpers (same UX as today's .sh)
    └── db.py                 # discover_port(engine), wait_for_db(host, port, engine)

infra/environments/local/bootstrap.py
infra/environments/local/scripts/discover_db_port.py
infra/environments/local/post/scripts/wait_for_db.py
infra/modules/cognito/scripts/create_user_pool_client.py
infra/modules/cognito/scripts/set_pre_token_trigger.py
```

Installed via `pip install -e infra/scripts` into the root `.venv/`. The shared `lib3mrai`
package removes duplication that exists today: the three AWS-touching scripts each
re-implement endpoint/credential defaulting, and the color helpers are repeated across scripts.

## Interface Compatibility (must not change)

- `discover_db_port.py <engine>` prints **only** the port to stdout, non-zero exit + stderr
  message on failure (the Makefile captures stdout).
- `wait_for_db.py <host> <port> <engine>` keeps positional args and exit codes: `0` (ready),
  `1` (timeout), `2` (unknown engine).
- Both Cognito scripts keep reading the same env vars (`USER_POOL_ID`, `LAMBDA_ARN`,
  `CLIENT_NAME`, `STATE_FILE`, `ENDPOINT_URL`, `AWS_REGION`) and keep writing the same
  `STATE_FILE` JSON shape.
- `discover_db_port` becomes importable, so `bootstrap.py` imports it directly instead of
  shelling out to a subprocess.
- All scripts remain idempotent, as today.

## Makefile Changes

- New `make scripts-setup`: creates `.venv/`, installs deps. Idempotent (no-op when the venv
  already exists).
- Targets that trigger a Terraform apply **depend on** `scripts-setup`, so it is invisible and a
  fresh clone cannot hit a cryptic `python: not found` from inside a `local-exec`.
- `PY := $(REPO_ROOT)/.venv/bin/python` replaces the `bash ...` invocations.
- `.gitignore` gains `.venv/` and `__pycache__/`.

## Convention Deliverable (implementation-time, not this spec)

A new note `docs/shared/conventions/scripting-language.md` will record the decision tree:

- **Python first** — infra scripting, pre/post effects, anything touching AWS, JSON, or
  non-trivial control flow.
- **JavaScript second** — when the task lives in the Node ecosystem already present (vault
  tooling, pnpm workspace, npm deps). This is what justifies keeping the three `.mjs` files.
- **Bash last** — only with an explicitly documented limitation; the convention requires
  recording the *why* in the script file itself.

Criteria for choosing: flexibility, customization, readability, performance, long-term
scalability. The note will be referenced from the root `CLAUDE.md` and `infra/CLAUDE.md` so it
survives across sessions. Those edits happen during implementation, not as part of this spec.

## Verification

Acceptance criterion: a full `make infra-down` followed by the complete cycle —
`infra-up` -> `infra-up-post` -> `bootstrap` -> `env-file` -> gateway E2E with a real Cognito
JWT — produces the same result as before the migration. No new unit-test layer is added for
single-use infra code; the existing E2E cycle is the guarantee. Per [[testing]]'s three-layer
convention, this milestone changes no HTTP endpoints, so layers (1) unit/integration, (2)
internal E2E, and (3) gateway E2E are unaffected by this work itself — the gateway E2E is used
here only as a regression check that infra bring-up still works after the interpreter swap.

## Risks / Open Points

- `make scripts-setup` becomes a prerequisite of apply; mitigated by making it an automatic
  Makefile dependency rather than a manual step developers must remember.
- Floci behavioral parity between boto3 and the `aws` CLI must be confirmed during
  implementation — both honor `AWS_ENDPOINT_URL`, but Floci is an emulator and could diverge
  on edge cases the CLI happens to paper over.
- Port-discovery non-determinism must be preserved in the Python version: Floci assigns
  ports 7000-7099 by cluster creation order, so postgres is **not** reliably on a fixed port.
  The Python `discover_port(engine)` must keep discovering per-engine via the `Engine` field
  returned by `describe-db-clusters`, never hardcode a port.

## Related

- [[2026-07-15-two-phase-post-effects-design]]
- [[awscli-fallback-for-floci]]
- [[testing]]
