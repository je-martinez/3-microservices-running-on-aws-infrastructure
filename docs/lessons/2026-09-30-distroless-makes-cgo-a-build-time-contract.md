---
title: "Distroless makes CGO a build-time contract"
type: lesson
area: tracking
status: active
created: 2026-09-30
updated: 2026-09-30
tags:
  - type/lesson
  - area/tracking
  - status/active
  - severity/medium
related:
  - "[[2026-08-27-tracking-go-migration-design]]"
  - "[[code-comments]]"
---

# Distroless makes CGO a build-time contract

The tracking-go runtime stage is `gcr.io/distroless/static-debian12:nonroot`. Choosing it converts several runtime conveniences into **build-time contracts**. The Go migration design only shows "multi-stage: build to distroless" in a tree diagram; the discipline below was undocumented.

## The contracts

- **`CGO_ENABLED=0` is load-bearing, not habit.** The image carries no libc. A cgo-linked binary **builds fine** and then dies at exec with `no such file or directory`. That message names the **binary**, not the missing dynamic loader, so it reads as a broken `COPY`. That misdirection is the whole lesson.
- **No shell.** There is no `docker exec ... sh`. Debug by reading logs, or exec into a peer container that shares the network and env file.
- **No `HEALTHCHECK` instruction.** No curl, wget or shell exists to run one. The healthcheck is defined host-side in `docker-compose.yml`.
- **`ENTRYPOINT` in exec form, not `CMD`.** With no shell there is nothing to interpolate, and an entrypoint makes `docker run tracking-go --flag` append to the binary rather than replace it.
- **`-trimpath`** strips local build paths; **`-ldflags="-s -w"`** drops the symbol table and DWARF.

## No docker-watch counterpart

The compose file deliberately has no `develop:` (watch) block for this service. Go is compiled: a synced source file changes nothing in a running container. A code change means `docker compose up -d --build tracking-go`. That is the honest cost of the runtime, not a gap in the setup.

## Related

- [[2026-08-27-tracking-go-migration-design]]
- [[code-comments]]
