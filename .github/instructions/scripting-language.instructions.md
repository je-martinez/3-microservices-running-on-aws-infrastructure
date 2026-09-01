---
applyTo: "**/*.py,**/*.mjs,**/*.js,**/*.sh,**/Makefile"
description: "Scripting language — Python first"
---

# Scripting language — Python first

- **Python by default** for new scripts: infra scripting, Terraform pre/post
  effects, and anything touching AWS, JSON, or non-trivial control flow.

> **Python is the scripting default and has not left this repo.**
> `infra/scripts/lib3mrai/`, `doctor.py`, `bootstrap.py` and ~29 other files are
> Python and stay Python. What ended on 2026-08-27 is Python as a **service
> runtime**: the four service runtimes are Node/Fastify (Users), .NET (Orders),
> Go/Gin (Tracking), and Node/TypeScript (the two Lambdas). Do not read the Go
> migration as a reason to write a new infra script in anything but Python.
- **JavaScript** only when the task already lives in the Node ecosystem present
  here (vault tooling, the pnpm workspace, its dependencies). That is why
  `scripts/*.mjs` stay JS.
- **Bash** only with an explicitly documented limitation, recorded in a comment
  inside the script itself. The repo currently has **zero `.sh` files** — keep it
  that way unless you can write down why Bash was unavoidable.

## Running Python

Infra Python scripts run from the repo venv. `make scripts-setup` creates it
(idempotent, and a prerequisite of every apply target). Terraform and the
Makefile invoke `.venv/bin/python` by **absolute path** — never plain `python3`
off `PATH`, which may resolve into an unrelated venv.

## Shared helpers

Shared helpers live in `infra/scripts/lib3mrai/` (`aws.py`, `console.py`,
`db.py`). Do not duplicate boto3 client setup or console helpers. Scripts stay
**colocated** with the Terraform module that invokes them.

## Node.js version

The repo pins Node via `.nvmrc` (currently **24.18.0**). Activate the pinned
version before running any Node command (`node`, `pnpm`, `pnpm dlx`, global
installs). With nvm: `nvm use && node scripts/validate-vault.mjs`.

The package manager is **pnpm — never `npm` or `yarn`**. Full rule:
`.ai/rules/package-manager.md`.