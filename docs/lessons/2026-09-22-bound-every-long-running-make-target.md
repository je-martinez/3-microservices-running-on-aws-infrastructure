---
title: "Bound every long-running make target"
type: lesson
area: shared
status: active
created: 2026-09-22
updated: 2026-09-30
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/medium
related:
  - "[[2026-09-09-makefile-orchestration-invariants]]"
  - "[[2026-08-27-accumulated-local-state-degrades-the-stack-silently]]"
  - "[[local-dev]]"
---

# Bound every long-running make target

## Rule

An unattended or agent-run long target must be bounded, and two of them must never be chained. An unbounded run hangs the session, and a chain turns a slow run into corrupted state.

- **One long target per command.** Never `A && B` when either can take minutes.
- **Put a watchdog inside the command**, so it dies on its own and leaves a log:

  ```bash
  cmd > log 2>&1 & P=$!; ( sleep 600; kill -TERM $P 2>/dev/null ) & W=$!; wait $P; kill $W
  ```

- **Never use `timeout`.** It does not exist on macOS (it is GNU coreutils), so a watchdog written with it fails with `command not found` and the target never runs at all. This still reproduces; it was hit again on 2026-09-30, and neither `timeout` nor `gtimeout` is installed on the dev machine.
- **Check progress at intervals**, not only at the end.

## Recovery at a terminal versus an unattended run

The root `Makefile`'s reconcile-failure message tells the user to run `make clean && make bootstrap`. That is consistent with this rule:

- As a **recovery step a human runs at a terminal, watching it**, the chain is the documented fix for a Terraform/Floci state divergence that a refresh cannot repair. See [[2026-09-09-makefile-orchestration-invariants]].
- As an **unattended or agent-driven run** it is the hazard: nobody is watching, so a hang or a kill lands mid-`destroy`. Run `make clean` and `make bootstrap` as two separate bounded commands and check each result.

## Evidence

- A `terraform destroy` sat **26 minutes** on one CloudWatch log group before anyone noticed.
- `make clean && make bootstrap` chained in one command was killed mid-`destroy`, leaving Terraform state half-destroyed and breaking the next three bootstraps. The chain is what turned a slow run into corrupted state.

## Related

- [[2026-09-09-makefile-orchestration-invariants]]
- [[2026-08-27-accumulated-local-state-degrades-the-stack-silently]]
- [[local-dev]]
