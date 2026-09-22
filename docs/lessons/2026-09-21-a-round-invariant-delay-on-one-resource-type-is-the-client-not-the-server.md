---
title: "A round, invariant delay on one resource type is the client, not the server"
type: lesson
area: infra
status: active
created: 2026-09-21
updated: 2026-09-21
tags:
  - type/lesson
  - area/infra
  - status/active
  - severity/medium
related:
  - "[[ADR-0017-floci-local]]"
  - "[[awscli-fallback-for-floci]]"
  - "[[local-dev]]"
  - "[[local-dev-floci]]"
  - "[[2026-09-09-makefile-orchestration-invariants]]"
  - "[[terraform-modules]]"
---

# A round, invariant delay on one resource type is the client, not the server

## Finding

During a bootstrap-performance investigation (`perf/bootstrap-timing`, 2026-09-21), every SQS
resource in `make infra-up` took **exactly 25 seconds** to create or update against Floci —
three queues plus three queue-attribute resources (policies and a redrive-allow policy) — while
111 other resources in the same apply, including an SNS topic and an SNS subscription, created
in 0 seconds. The six SQS resources chain through the dependency graph into three sequential
25-second waves (~75s total), inside an `infra-up` stage that otherwise runs a stable 97-99s.

The natural read of "suspiciously round, perfectly invariant, isolated to one resource type" is
"the emulator has a fixed delay for this operation." That is the wrong conclusion, and it is
the reusable part of this lesson.

## The discriminating test

Time the raw SDK/CLI call against the **same running endpoint**, outside Terraform:

```console
/usr/bin/time -p env AWS_ENDPOINT_URL=http://localhost:4566 AWS_DEFAULT_REGION=us-east-1 \
  AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
  aws sqs create-queue --queue-name probe-sqs-delay --attributes VisibilityTimeout=31
```

Result: `real 0.37s`. `set-queue-attributes` against the same queue: `0.38-0.40s`. Same Floci
container, same queue, same operation Terraform issues — 0.37s from the CLI, 25s from
`terraform apply`. That gap is the whole diagnosis: the server answers in under half a second,
so the remaining ~24.6s cannot be server work, polling, or an emulator setting. It has to be
something the **client** does after the server already answered.

## Root cause

The pinned `hashicorp/aws` provider (`= 5.31.0`, required for Floci — see
[[ADR-0017-floci-local]]) calls `waitQueueAttributesPropagated` after every `CreateQueue` and
`SetQueueAttributes`, to protect against real AWS's cross-partition eventual consistency. The
waiter is configured with `ContinuousTargetOccurence: 6` and `MinTimeout: 5 * time.Second`. The
Terraform Plugin SDK's state-change waiter does the first read immediately, then sleeps
`MinTimeout` before each of the remaining five reads needed to reach six consecutive successes:
`5 x 5s = 25s`, fixed, regardless of how fast the underlying read actually is. Floci returns the
correct attributes on the very first read — there is nothing to wait for — but the six-success
rule is hard-coded in the provider binary and cannot finish early.

This explains every observed fact at once: the exact 25s (five fixed sleeps, not variable
server work), why it hits only SQS (no other resource in this stack has this specific waiter),
and the three sequential waves (the DLQ, then the main/notifications queues, then the three
standalone attribute resources, each depending on the previous).

## Why this generalizes beyond SQS

Nothing about the diagnosis is SQS-specific. Any time a resource against a local emulator shows
a delay that is (a) exactly reproducible down to fractions of a second across independent runs,
(b) isolated to one resource type while siblings created in the same apply are near-instant, and
(c) a round number — the delay is a strong candidate for a **client-side wait written for a
different consistency model** (a provider waiter, an SDK retry/backoff table, a fixed sleep in
application code) rather than emulator latency. The fix for that class of problem is never "try
a faster emulator" — a faster server still receives the same client-side wait, which is exactly
why switching local AWS emulators was considered and rejected here as a non-solution. The fix is
either accepting the wait, or bypassing the specific client code path that imposes it.

## Not fixable by configuration

None of Floci's SQS environment variables, the provider's `max_retries`/HTTP timeout settings,
nor a resource `timeouts` block can change `ContinuousTargetOccurence` or `MinTimeout` — both
are hard-coded inside the resource implementation, not exposed as provider or resource
configuration. Upgrading the provider does not help either: the same two constants are still
present on the provider's `main` branch, and this repo cannot upgrade freely regardless, because
a newer provider's Cognito behavior is incompatible with Floci (see [[ADR-0017-floci-local]]).

## Options considered, none adopted

1. **Local-only fallback** — bypass the six native SQS resources under
   `infra/environments/local` with the repo's established `terraform_data` + idempotent boto3
   pattern (see [[awscli-fallback-for-floci]]), keeping the native provider resources for
   production. Estimated saving: `infra-up` 97.7s -> ~56-60s, full bootstrap ~427s -> ~385-389s
   (about 9-10%, not the naive 75s, because Aurora's own 33-35s critical path is the next
   bottleneck once SQS's is removed).
2. **Fork the provider** to soften the waiter — rejected: ongoing supply-chain and upgrade
   burden for a local-only 40-second saving.
3. **Upstream feature request** to HashiCorp for an opt-in waiter policy on custom endpoints —
   not solved by any existing release.
4. **Accept it and document it** — the option chosen here. The module also serves production,
   and trading away Terraform drift detection on six resources was judged not worth ~40 seconds
   of local bootstrap time. No Terraform, Compose, Makefile, or Floci change was made as part of
   this investigation.

## Environment pinning note

`docker-compose.yml` pins `floci/floci:latest` (unpinned by digest). The behavior measured here
was against Floci image label `1.7.0`. A future image pull can change emulator behavior, but it
cannot remove this wait, because the wait is enforced by the Terraform provider client, not by
whatever Floci returns.

## Related infra timing work from the same investigation

Two applied changes from the same session, kept here because they were measured together and
both bear on `make bootstrap` timing:

- **`TF_PLUGIN_CACHE_DIR`** was added to the Makefile so the three Terraform roots (backend,
  local, post — all pinned to `hashicorp/aws 5.31.0`) share one provider plugin cache instead of
  each installing its own ~400-500MB copy. Verified: `infra-init` 23.7s -> 6s, `post-infra`
  38.0s -> 12s, `backend-up` 13.7s -> 11s.
- **A `clean-state` target** was added alongside `clean`: same Terraform/container state
  teardown, but skipping `docker builder prune -af` / `docker image prune -f`. Warm builds then
  take under 1.3s each instead of a full rebuild, projecting full bootstrap from 7m07s to
  roughly 3m35s. The documented trade-off is the unbounded build-cache/dangling-image growth
  that `clean`'s prunes exist to prevent (6.4GB cache + 2.2GB dangling images measured on this
  machine) — `clean-state` is for iterating quickly, not a replacement for `clean`.
- Separately confirmed: BuildKit `type=cache` mounts do **not** survive `docker builder prune`
  (with or without `-a`), which is why a cache-mount strategy was rejected in favor of the
  `clean-state` target above.

## Related

- [[ADR-0017-floci-local]] — the provider pin (`= 5.31.0`) this waiter behavior belongs to, and
  the reason a newer provider is not a free fix.
- [[awscli-fallback-for-floci]] — the established local-only bypass pattern this investigation's
  (not-yet-applied) proposed fix would extend to SQS.
- [[local-dev]] / [[local-dev-floci]] — the `make bootstrap`/`make clean` chain this delay sits
  inside, and where `TF_PLUGIN_CACHE_DIR`/`clean-state` change measured timings.
- [[2026-09-09-makefile-orchestration-invariants]] — the neighboring lesson on why the bootstrap
  chain is ordered the way it is; this note adds the "why is one stage of it slow" half.
- [[terraform-modules]] — module inventory; `infra/modules/messaging` is the module that owns
  the six SQS resources this investigation measured.
