---
title: Environment Exclusivity — dev and pre-prod never run together
type: convention
area: shared
status: active
created: 2026-10-03
updated: 2026-10-03
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[2026-10-02-floci-preprod-environment-design]]"
  - "[[2026-10-02-floci-preprod-environment]]"
  - "[[ADR-0022-preprod-ecs-on-floci]]"
  - "[[preprod]]"
  - "[[local-dev-floci]]"
  - "[[local-dev]]"
  - "[[2026-09-30-a-tty-less-prompt-resolves-to-a-silent-success]]"
---

# Environment Exclusivity — dev and pre-prod never run together

The dev stack (`docker-compose.yml`, project `3mrai`) and the pre-prod stack
(`docker-compose.preprod.yml`, project `3mrai-preprod`) are **mutually exclusive**. Starting
either one while the other is up is refused or confirmed, never silently allowed.

## Why

Both environments need the same two things on the host:

- **Port `4566`** — Floci's AWS API surface.
- **The fixed-name `floci-ecr-registry` container** — Floci's ECR backend.

ECR repository URIs are always `<account>.dkr.ecr.us-east-1.localhost:4566/...`, and
`FLOCI_BASE_URL` does not change that. With two Floci instances up, the Docker daemon resolves
the registry to whichever instance owns `:4566`, so an ECS task pulls from the wrong Floci
(observed as `NoSuchBucket` on pull). Pre-prod must therefore own `:4566`, and dev must not.

## The rule

1. **Entry points are guarded.** `make up`, `make bootstrap` and `make bootstrap-provision`
   (dev) and `make preprod-floci-up` (the first step of `make preprod-up`) call
   `infra/scripts/env_guard.py <target>` before touching Docker.
2. **The other environment running means a prompt** with exactly two answers: **drop** the other
   environment (the guard runs its teardown: `make clean` for dev, `make preprod-down` for
   pre-prod) and continue, or do **nothing** (the target aborts and leaves the other running).
3. **No TTY means abort.** A guard that cannot ask never drops anything. It prints the teardown
   command to run and exits non-zero. A prompt that resolves to a silent success is the failure
   mode recorded in [[2026-09-30-a-tty-less-prompt-resolves-to-a-silent-success]].
4. **Detection is by compose project label** (`com.docker.compose.project=3mrai` or
   `3mrai-preprod`), not by port. The guard lists only RUNNING containers (`docker ps -q`), so a stack whose
   containers are created or exited is treated as down.

5. **Teardowns are guarded in both directions (mirror of the start guard).** `make preprod-down`
   first runs `infra/scripts/env_guard.py --check-other preprod` and refuses while dev runs;
   `make clean` and `make clean-state` (dev) first run `env_guard.py --check-other dev` and refuse
   while pre-prod runs. Neither refusal prompts or depends on a TTY. Both teardowns run the same
   `name=^floci-` and `label=floci=true` sweeps, and `make clean` / `make clean-state` also remove
   `docker volume rm floci-ecr-registry-data`, so running one beside the other environment would
   delete its containers, data and registry volume and leave phantom databases reported
   `available`. The refusal prints the other environment's teardown command (`make clean` or
   `make preprod-down`); drop it first if that is intended. Verified live on 2026-10-03; see
   [[2026-10-03-floci-preprod-follow-ups]].

## What each teardown costs

Dropping dev wipes its Floci state (`make clean`; regenerable with `make bootstrap`). Dropping
pre-prod wipes everything in it (`make preprod-down`; regenerable with `make preprod-up`, about
3m40s from scratch). Pre-prod is disposable by design — see [[preprod]].

## Mechanism

`infra/scripts/env_guard.py` has two modes:

- `env_guard.py <dev|preprod>` is the start guard (rule 1-3): prompt, drop or do nothing.
- `env_guard.py --check-other <dev|preprod>` gates a teardown of the named environment: exit 1
  when the other environment's compose project has running containers, 0 otherwise.

## Adding another environment

A third environment that needs `:4566` or the ECR registry registers its project name and
teardown target in the `ENVIRONMENTS` map of `infra/scripts/env_guard.py` and calls the guard
from its entry targets.

## Related

- [[2026-10-02-floci-preprod-environment-design]]
- [[2026-10-02-floci-preprod-environment]]
- [[ADR-0022-preprod-ecs-on-floci]]
- [[preprod]]
- [[local-dev-floci]]
- [[local-dev]]
- [[2026-09-30-a-tty-less-prompt-resolves-to-a-silent-success]]
- [[2026-10-03-floci-preprod-follow-ups]]
