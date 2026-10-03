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
   `3mrai-preprod`), not by port, so a half-started stack still counts as running.

## What each teardown costs

Dropping dev wipes its Floci state (`make clean`; regenerable with `make bootstrap`). Dropping
pre-prod wipes everything in it (`make preprod-down`; regenerable with `make preprod-up`, about
3m40s from scratch). Pre-prod is disposable by design — see [[preprod]].

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
