---
title: "A pruned cache that came over the network is not free"
type: lesson
area: infra
status: active
created: 2026-09-22
updated: 2026-09-22
tags:
  - type/lesson
  - area/infra
  - status/active
  - severity/high
related:
  - "[[2026-09-21-a-round-invariant-delay-on-one-resource-type-is-the-client-not-the-server]]"
  - "[[ADR-0017-floci-local]]"
  - "[[local-dev]]"
  - "[[local-dev-floci]]"
  - "[[2026-09-09-makefile-orchestration-invariants]]"
---

# A pruned cache that came over the network is not free

## Finding

`make clean`'s `docker image prune -f` + `docker builder prune -af` used to carry a comment
claiming the cost of dropping the build cache was "one slower rebuild" — i.e. bounded, and paid
once. That claim was **false**, and measurably so. What those two commands drop is not just
compiled layers computed locally — it is everything the build **fetched over the network**, and
re-fetching means hitting a public registry that throttles a client it has already seen. The
cost is not a flat "slower" — it is **non-linear and compounds across repeated cycles**, because
each successive pull from the same client gets slower, not just paid again at the same price.

## The generalizable lesson

**A teardown that prunes caches is not merely "slower to rebuild" if what it pruned came over the
network.** Local compute (layer extraction, a `RUN` that only touches files already on disk) is
flat-cost to repeat: paid once per cycle, same price every time. Anything fetched from an
external registry is not, because registries rate-limit or throttle repeat clients, and that
throttling compounds the more times you ask.

**The discriminating question when a build step degrades across repeated runs is "is this
transfer or compute?"**, answered by comparing download time against extraction time in the
*same log*. If extraction time is flat while transfer time grows, the bottleneck is the network
and the client's behavior toward it — not the disk, not the CPU, not "the machine getting
slower." This is the same diagnostic shape as
[[2026-09-21-a-round-invariant-delay-on-one-resource-type-is-the-client-not-the-server]] (the SQS
25-second waiter): both findings came out of asking "is the round/growing number actually the
server, or is it something the client does that the server has no part in?" — there it was a
hard-coded waiter loop, here it is repeated exposure to a throttling registry. Neither is fixed
by a faster server; both are fixed by changing what the client does.

## Measured evidence

3 arms x 5 iterations, interleaved A/B/C so machine drift could not be confounded with the
effect:

- **Arm A** (`make clean` + bootstrap) degraded **monotonically** across five iterations:
  6m13s -> 7m00s -> 9m31s -> 10m38s -> 12m35s (+102%). The fifth run took twice the first.
- **Arms B and C** (`clean-state`, which keeps the build cache) stayed flat: CV 5.4% and 1.6%.
- **Root cause**, isolated by per-step log analysis: one step absorbed all the degradation —
  68s -> 242s -> 409s — while every other step held at ~20s. It was the
  `mcr.microsoft.com/dotnet/sdk:10.0` pull (184.89MB), and its bandwidth collapsed monotonically:
  2831 -> 2011 -> 774 -> 583 -> 456 KB/s. That is a 6.2x slowdown on the fifth pull. **Layer
  extraction stayed at 2.4s throughout** — the discriminating comparison above, applied: transfer
  degraded, compute did not, so the cause was the registry relationship, not the machine.

## The non-obvious mechanism: BuildKit does not use the image store

With BuildKit (driver `docker`, the default), a `FROM` inside a build does **not** populate
Docker's image store. The layers land in BuildKit's own content cache instead. Every consequence
below was verified by experiment on this branch:

- `docker images` never shows `mcr.microsoft.com/dotnet/sdk:10.0`, even immediately after a
  build that used it.
- `docker image prune -f` does **not** remove it — that command only removes dangling images,
  and this layer was never a tagged image in the first place. (The old Makefile comment was
  correct about this half.)
- `docker builder prune -af` **does** remove it, because it lives in BuildKit's cache, which is
  exactly the state that command targets.
- `docker compose build` and `docker compose up` never leave a tagged base image behind either —
  checked explicitly, since it is the reasonable next guess ("surely compose already caches
  it"). It does not: compose builds through BuildKit the same way a bare `docker build` does.
- An explicit `docker pull` **does** write to the image store, and a tagged image there survives
  both prunes.

This is the whole reason the old comment was wrong in a way that felt right: it is true that
`image prune -f` does not touch these base images, so testing only that command would appear to
confirm "nothing stateful is dropped." The claim only breaks once `builder prune -af` — the
other half of the same `clean` step — is accounted for.

## The fix

Two parts, both implemented and measured on `perf/bootstrap-timing`:

1. **`make warm-images`** — `docker pull` of all 8 external base images (`node:24-alpine`,
   `mcr.microsoft.com/dotnet/sdk:10.0`, `mcr.microsoft.com/dotnet/aspnet:10.0`,
   `golang:1.26.7-bookworm`, `nginx:1.27-alpine`, `gcr.io/distroless/static-debian12:nonroot`,
   `mysql:8.0`, `migrate/migrate:v4.17.1`) into the image store. Idempotent — skips whatever is
   already present. 7s cold, 1s warm. Result: **zero** Docker layer downloads across a subsequent
   9-run experiment, including the 3 runs that ran a full `clean`.
2. **`make warm-nuget`** + `infra/docker/nuget-cache.Dockerfile` — a second network dependency
   found only after fixing the first: `dotnet restore` for Orders against `nuget.org`. Same class
   of problem, different registry. One run measured the restore going from 15s to 3.13min, with
   four 100-second HTTP timeouts along the way. The fix follows the same principle: a tagged
   image (`3mrai-nuget-cache:latest`) carries the already-restored packages, consumed by
   `services/orders/Dockerfile` via `ARG SDK_IMAGE` (defaulting to the plain SDK, so the
   Dockerfile still builds standalone) and passed in by `docker-compose.yml`.

Both targets are, deliberately, **image-based, not cache-mount-based** — see the next section for
why that distinction is load-bearing rather than a style choice.

### Measured results of `warm-nuget`, after `docker builder prune -af` each time

- **No source change:** 18s, restore resolved offline, zero `nuget.org` fetches.
- **Adding a new library** (`FluentValidation`, tested explicitly): 59s, restore 41.6s, and
  **only** the new package was fetched — confirmed by inspecting the cache image, which holds 116
  pre-restored packages and does not contain FluentValidation. This answers the obvious
  objection up front: the cache does not become stale garbage the moment a dependency changes —
  it covers the new-dependency case usefully, if partially. You pay for what is new, once, not
  for the whole graph on every cycle.

## Two approaches that do not work — do not retry them

- **`--mount=type=cache`** — does **not** survive `docker builder prune`, with or without `-a`.
  Proven separately in this session with a marker-file experiment whose counter went 5 -> 1
  across a prune. It is destroyed by plain `builder prune -f` too, not only the `-a` form.
- **`--mount=type=bind,...,rw`** from the build context — the build succeeds, but BuildKit
  **discards the writes**; the target directory was left with 0 entries afterward.
- **A named volume declared in `docker-compose.yml`** would carry the label
  `com.docker.compose.project=3mrai`, which `make clean` explicitly sweeps (see
  [[2026-09-09-makefile-orchestration-invariants]]) — so it would die on every `clean` too, for a
  different but equally fatal reason.

The common thread: any cache mechanism that lives in BuildKit's own state, or that reuses a label
`clean` is designed to sweep, is fighting the very teardown it needs to survive. Only a **tagged
image in the Docker image store** is outside both blast radii.

## An important caveat, recorded honestly

A follow-up 3-arm x 3-iteration experiment **with `warm-images` in place** showed arm A at
4m55s / 7m54s / 4m53s. The middle run was a `nuget.org` incident (four timeouts) — this was
*before* `warm-nuget` existed — not resumed degradation: A-1 and A-3 are within 2.5s of each
other. The monotonic escalation is gone; what remained was an unpredictable vulnerability to
registry slowness on the *other* network dependency, which `warm-nuget` then addressed.

Also worth stating plainly: arms B and C improved ~10-18s between the two experiments without any
change that should affect them, so some of the apparent gain is environmental noise, not
attributable to either fix. What **is** unambiguously attributable to the fix: zero downloads,
and the disappearance of the monotonic pattern.

## The Makefile comment this corrects

The `clean:` target's comment claiming the prunes cost only "one slower rebuild" is the thing
this investigation disproved — it undercounted the cost by treating "slower" as bounded and
one-time when it is actually unbounded and compounding. The Makefile comment itself is being
corrected in the same branch as a separate edit (not by this note); this lesson is the durable
record of *why* it was wrong and what replaced it (`warm-images` + `warm-nuget`, both now called
from `bootstrap-converge` ahead of the builds they warm).

## Related infra timing work from the same investigation

Measured together with the above, on the same branch:

- `TF_PLUGIN_CACHE_DIR` and the `clean-state` target predate this note — see
  [[2026-09-21-a-round-invariant-delay-on-one-resource-type-is-the-client-not-the-server]]'s
  "Related infra timing work" section for those numbers.
- Measurement harnesses: `infra/scripts/measure_bootstrap.py` (per-stage timings) and
  `infra/scripts/compare_teardowns.py` (the 3-arm comparison used above). Raw data lands in
  `.bootstrap-timings/`, which is **gitignored and disposable** — anything worth keeping had to
  be written down here.

## Related

- [[2026-09-21-a-round-invariant-delay-on-one-resource-type-is-the-client-not-the-server]] —
  sibling finding from the same profiling effort: a client-side wait mistaken for server
  latency, versus this note's client-side re-fetch mistaken for a free rebuild. Same
  discriminating instinct ("is this really the server?" / "is this transfer or compute?"),
  different mechanism.
- [[ADR-0017-floci-local]] — the local Floci stack `make bootstrap` brings up; this note's fix
  runs ahead of the container builds that stack depends on.
- [[local-dev]] — the Makefile overview; documents `clean` vs `clean-state` and now needs no
  correction itself, since it never restated the false "one slower rebuild" claim, only pointed
  at the `clean:` target for the reasoning.
- [[local-dev-floci]] — the `make bootstrap` runbook; `warm-images`/`warm-nuget` run inside
  `bootstrap-converge`, ahead of the service builds.
- [[2026-09-09-makefile-orchestration-invariants]] — the neighboring lesson on why the bootstrap
  chain is ordered the way it is; this note documents why `clean`'s reclaim step is not the
  bounded, free-to-repeat operation its own comment used to claim.
