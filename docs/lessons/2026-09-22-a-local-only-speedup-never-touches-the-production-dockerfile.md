---
title: "A local-only speedup never touches the production Dockerfile"
type: lesson
area: shared
status: active
created: 2026-09-22
updated: 2026-09-22
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/medium
related:
  - "[[local-dev]]"
---

# A local-only speedup never touches the production Dockerfile

## Rule

When a change speeds up **only** local development (build-cache mounts, pre-warmed package caches, dev-only toolchains), do NOT edit the service's production `Dockerfile`. Create a sibling `Dockerfile.local` and point `docker-compose.yml` at it via `build.dockerfile`.

## Why

The Dockerfile is a production artifact. A local-only workaround baked into it ships to every environment that builds from it, and the performance win is worthless outside a developer machine. Keeping the two apart means the production image stays exactly as it was, and the local variant can take liberties (cache mounts that `make clean` prunes, extra tooling) without anyone auditing production having to reason about them.

## Current state

The repo has no `Dockerfile.local` yet, and `docker-compose.yml` references only the production Dockerfiles. This note defines the shape for the first one; it does not describe an existing arrangement.

## How to apply

- Add `services/<svc>/Dockerfile.local` and reference it from that service's compose `build.dockerfile`.
- Leave the production `Dockerfile` untouched.
- Each service's build `context` differs: tracking-go builds from its own directory, users, orders and web from the repo root. The local variant must honour the same context, or its `COPY` paths break.

## Origin

Stated by the user on 2026-09-22 while applying build-cache improvements from a four-provider audit, after `services/tracking-go/Dockerfile` was edited directly and corrected. The improvements were not carried through, so no `Dockerfile.local` exists.

## Related

- [[local-dev]]
