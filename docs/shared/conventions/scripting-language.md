---
title: Scripting Language
type: convention
area: shared
status: active
created: 2026-07-19
updated: 2026-07-19
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[2026-07-19-scripts-to-python-migration-design]]"
  - "[[developer-experience-milestone]]"
  - "[[local-dev]]"
---

# Scripting Language

## Rule — a decision tree, in strict order

**1. Python first.** Default for infrastructure scripting, Terraform pre/post effects
(`local-exec`), and anything touching AWS, JSON, or non-trivial control flow. Runs from the
repo venv created by `make scripts-setup`; callers invoke `.venv/bin/python` by **absolute**
path.

**2. JavaScript second.** When the task already lives in the Node ecosystem present in the
repo — vault tooling, the pnpm workspace, anything needing npm dependencies. The three
existing `scripts/*.mjs` (`validate-vault.mjs`, `drawio-to-svg.mjs`, `import-dashboards.mjs`)
are the standing example: they consume Node libraries and run under the repo's pinned Node
(`.nvmrc`), so moving them to Python would add a runtime without buying anything.

**3. Bash last.** Only with an explicitly documented limitation, and the *why* must be
recorded in a comment in the script file itself. As of 2026-07-19 the repo has zero `.sh`
files.

Selection criteria when the choice is genuinely close: flexibility, customization,
readability, performance, long-term scalability.

## Why this rule exists (the evidence)

Before the migration, two of the repo's five bash scripts were already Python wearing a bash
costume — `set-pre-token-trigger.sh` was a wrapper around a `python3 <<'PY'` heredoc that
itself shelled out to `aws` via subprocess, and `create-user-pool-client.sh` embedded
`python3 -c` to parse JSON. Bash could not parse JSON, so the scripts reached for Python
anyway, through the most awkward possible door. That is the tell that the default was wrong.

Concrete wins from choosing Python explicitly: boto3 replaced fragile `--query`/`--output
text` parsing and a `"None"`-literal string check standing in for a real null check;
`bootstrap.sh` went from 269 lines to 162 with the dead code removed; and shared logic (boto3
client construction, console helpers, DB discovery) moved into one package instead of being
re-implemented per script.

## Rules for new scripts

- New scripts default to Python. Choosing JavaScript or Bash instead is a decision that needs
  a stated reason.
- Shared logic goes in `infra/scripts/lib3mrai/` (`aws.py` — boto3 client factory honoring
  `AWS_ENDPOINT_URL`; `console.py` — `ok`/`no`/`inf`; `db.py` — `discover_port`,
  `wait_for_db`). Do not duplicate boto3 client setup or console helpers in a script.
- Scripts stay COLOCATED with the Terraform module that invokes them; only shared logic moves
  into the package.
- Terraform `local-exec` and the Makefile invoke the interpreter by absolute path via a
  `python_bin` variable (or `$(PY)`), never plain `python3` off `PATH` — a developer's shell
  may already be inside an unrelated venv, and an apply must not silently pick up a stray
  interpreter. Verified real risk: the ambient `python3` on the dev machine resolves into
  `~/.venvs/release-env/`.
- `make scripts-setup` is a prerequisite of every apply-triggering target, so the venv is
  created automatically; it is a file target on `.venv/bin/python`, hence idempotent.
- Preserve external interfaces when porting: CLI args, stdout contract, exit codes, env var
  names, state-file shapes. A script whose stdout the Makefile captures must print **only**
  the value to stdout and send diagnostics to stderr.

## Related

- [[2026-07-19-scripts-to-python-migration-design]]
- [[developer-experience-milestone]]
- [[local-dev]]
