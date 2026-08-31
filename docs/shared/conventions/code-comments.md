---
title: Code Comments
type: convention
area: shared
status: active
created: 2026-08-27
updated: 2026-08-27
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[scripting-language]]"
  - "[[doc-propagation]]"
  - "[[awscli-fallback-for-floci]]"
  - "[[floci-sqs-lambda-docdb-support]]"
  - "[[floci-elasticache-two-ports-and-provider-panic]]"
  - "[[logging-context]]"
  - "[[testing]]"
---

# Code Comments

## The problem (measured)

Comment blocks in this repo grew into essays explaining why a workaround exists or what the
local AWS emulator (Floci) cannot do. Measured across the repo, excluding `services/tracking/`
(pending Go migration) and `spike/`: **3,492 comment blocks**. p50=3 lines, p75=6, p90=12,
p95=17, p99=32, max=89.

The median block is already healthy; the problem is exclusively the tail. Blocks >12 lines:
321 (9.2%, 196 files). Blocks >20 lines: 114 (3.3%, 90 files).

By count of >12-line blocks, `orders` (95) > `e2e` (70) > `functions` (62) > `users` (57) >
`infra` (34) — infra only *feels* worst because its blocks are densest per file
(`infra/environments/local/main.tf` is 367/645 lines of comments, 56%).

Much of that infra prose duplicates vault notes that already exist
([[awscli-fallback-for-floci]], [[floci-sqs-lambda-docdb-support]],
[[floci-elasticache-two-ports-and-provider-panic]]) — the comment restates the whole story
instead of pointing at it.

Length is not the only axis: beyond block size, 98 comment lines narrate debugging history
and 38 still name the removed Jaeger. That axis is governed by "State, not history" below.

## Scope

This convention applies to comments in `.tf`, `.py`, `.ts`, `.js`, `.mjs`, and `.cs` source
files. It does not apply to `docs/` vault notes, generated files, or vendored code.
`services/tracking/` is excluded until the Go migration lands, and `spike/` is excluded as
throwaway.

## Rule

Code keeps the invariant, the failure consequence, and a pointer. The vault keeps the history,
rejected alternatives, measurements, error transcripts, and verification dates.

### Tagging — closed set of five

Every non-trivial comment block starts with exactly one of these tags. Scope values in
`WORKAROUND(<scope>):` are lowercase: `local`, `provider`, `runtime`.

| Tag | Purpose | Must state |
|---|---|---|
| `CONTRACT:` | Load-bearing invariant: identifier stability, serialization format, omission rule, cross-service schema | The invariant AND what breaks if violated |
| `WORKAROUND(<scope>):` | Deliberate departure from normal code due to an external constraint | What is bypassed, the failure symptom, and why prod differs |
| `WHY:` | Non-obvious local decision whose rationale fits inline | The reason, not code narration |
| `WARNING:` | Operational hazard or security boundary | The concrete consequence, not "be careful" |
| `TODO(JE-<id>):` | Tracked debt | Linear issue ID and the removal condition |

Exempt from tagging: one-line section dividers (`# ─── Name ───`) and tool directives
(`// eslint-disable`, `# tfsec:ignore`).

Rejected tags, one reason each:

| Tag | Reason rejected |
|---|---|
| `FIXME:` | Duplicates `TODO:` without ownership or an exit condition |
| `HACK:` | States the author's opinion, not whether the code is safe to remove |
| `XXX:` | No stable meaning, hostile to search |
| `NOTE:` | Becomes a catch-all that defeats the taxonomy |

Obvious narration (`// Return the result`) and commented-out code must not be committed —
version control already preserves the latter.

### References — `See [[vault-id]]`

Use an Obsidian wikilink with the bare note basename: `See [[awscli-fallback-for-floci]]`. A
reference must not include a leading `docs/`, a trailing `.md`, or a heading anchor.

> Rationale: `scripts/validate-vault.mjs` sets `ROOT = "docs"` and its `resolves()` function
> indexes bare basenames and vault-relative paths. A bare basename survives a note moving
> between `docs/lessons/` and `docs/shared/patterns/`, while `See docs/shared/patterns/foo.md`
> does not resolve against that function and rots the moment the note moves. Heading anchors
> are stripped by the `[^\]|#]+` match and never validated, so they rot silently.

Every `CONTRACT:` and `WORKAROUND(...)` block carries a `See [[...]]` reference where a durable
vault note exists. `WHY:` may omit it.

### Length

- Untagged comment: up to 6 lines (p75, the repo's own healthy norm). Keep it to 3 where the
  point fits in 3. Section divider: 1 line.
- 7–12 lines: allowed only when tagged `CONTRACT:`/`WORKAROUND(...)` **and** carrying a
  `See [[...]]`.
- **>12 lines MUST NOT be committed — hard error.**

> Rationale: 12 is p90, isolating the 321 essay blocks (9.2%) that are the actual problem
> while leaving the healthy median untouched. A gate at >8 lines would flag 580 blocks across
> 271 files (16.6%), which forces a risky repo-wide refactor instead of steady improvement.

### Placement

1. Put the tagged entry immediately above the smallest resource, argument, or statement it
   governs.
2. Tag goes on the first line after the comment delimiter.
3. In C# XML docs, keep tags inside `<remarks>` or a concise `<param>`; never invent custom
   XML pseudo-elements — they corrupt IDE tooltips and Roslyn analyzers.
4. Never paste CLI transcripts, stack traces, or verification dates (`verified 2026-08-09`)
   into source. Those belong in the vault note.
5. Repeat a `CONTRACT:` at each independent site that can violate it. Do not repeat the
   history.
6. Prefer executable enforcement where possible (a validation, type, schema, or Terraform
   precondition). The comment explains the non-local reason the enforcement exists.

### Preserving agent context

A bare `See [[note]]` with no prohibition is insufficient — an agent treats the vault as
optional background and may never open it. Every `CONTRACT:`/`WORKAROUND(...)` **must** keep,
inline, both:

1. The explicit prohibition (what must not change).
2. One concrete failure symptom (`panics the provider and wedges state`, `ECONNREFUSED inside
   the network` — not "this is important").

A module-wide guard belongs in the nearest `CLAUDE.md` rather than repeated per resource.
Compressing an existing block must preserve the prohibition and the consequence — that is the
one thing a reviewer checks when an agent is asked to "shorten comments," because deleting the
invariant and leaving only the link is the known failure mode this rule exists to prevent.

Defense in depth, three layers:

1. The tagged comment at the mutation site.
2. The nearest `CLAUDE.md`, for module-wide policy.
3. The vault note via `See [[...]]`, for the full record.

### State, not history

A comment describes the code as it exists today, not the debugging journey that produced it.
When you fix a block you previously commented, rewrite the comment to describe the final
state — never append to it. Past-tense narration of earlier attempts (`used to`, `previously`,
`tried`, `turned out`, `the fix was`, `no longer`) does not belong in source.

This axis is narrative accumulation, **not line count**: a 3-line comment can be a diary, and a
12-line comment can be a clean description. It is independent of the Length rule above.

> Rationale: accumulated history rots without any compiler or linter feedback. Measured in this
> repo: 98 comment lines carry narrative markers (functions 28, orders 27, users 25, e2e 10,
> infra 8), and **38 comments still name Jaeger**, which was removed on 2026-08-21 and no
> longer runs anywhere in the stack. The history did not merely add noise — it went stale and
> now misinforms every reader, human or agent.

What stays in code versus what moves to a vault note:

| Stays in code (present tense) | Moves to a vault note |
|---|---|
| The invariant the code enforces today | The chronological sequence of attempts |
| The explicit prohibition (`Do NOT …`) | Why an earlier hypothesis failed |
| One concrete failure symptom | Error transcripts, stack traces, CLI output |
| Systems that currently exist | Retired systems and removed packages |
| `See [[vault-id]]` | The full diagnosis and its measurements |

Load-bearing history is not deleted, it is relocated. The knowledge that stops someone
re-trying a failed approach survives as a prohibition, not as a story. Dated lessons live in
`docs/lessons/YYYY-MM-DD-<title>.md`.

**The negative-constraint form** is how a failed attempt is preserved without narrating it:

```
// CONTRACT: Do NOT <prohibited action>. <Concrete failure symptom>.
// See [[vault-id]]
```

```
// WORKAROUND(<scope>): Do NOT rely on <mechanism>. <Failure symptom if violated>.
// See [[vault-id]]
```

Writing one:

1. Present tense or imperative — never "we tried".
2. Name the prohibited action explicitly.
3. Name the exact failure symptom, not a vague warning.
4. Carry `See [[vault-id]]` when a durable note exists.

**Regression guards in tests.** A test comment saying "this used to assert X, now asserts Y"
is a regression guard wearing a diary's clothes. The test body already shows current
behaviour; the comment names what bug returns if the assertion is reverted. Write it with
`CONTRACT:` — do NOT introduce a new tag, the set of five is closed. Where a legacy class or
file name is now misleading, one `WHY:` line may explain it.

Real example, `services/orders/tests/Orders.Tests/Identity/ReadsNoGrpcTests.cs`:

```csharp
// CONTRACT: Reads resolve user_id via gRPC, exactly once per request. Without it, log lines
// join only by cognito_sub, which Users and Tracking do not key on.
// WHY: The class name predates gRPC on reads.
// See [[logging-context]]
```

What it replaces — the thing not to write:

```csharp
// That reverses what this file used to assert. Reads previously made no gRPC call at all…
```

**The three-second test.** Run this before committing a comment:

1. **Tense** — does a sentence describe earlier code or a past debugging step? Rewrite it in
   the present, or move it to a lesson note.
2. **Ghost** — does it name a library, service, or port that is not in the current stack?
   Delete the ghost.
3. **Deletion** — if you delete the sentence, is a prohibition lost? If yes, condense it into
   a negative constraint. If no, delete it.

**Worked rewrite** — `services/users/src/shared/auth/cognito-auth-provider.ts`. This one saves
only one line; the point is that the comment stops narrating and starts prohibiting, which no
length rule would ever catch.

BEFORE:
```typescript
// A missing `sub` used to fall back to the email. That is a silent
// corruption: the email would be hashed into the idempotency key as if it
// were a sub. Fail loudly instead.
```

AFTER:
```typescript
// CONTRACT: Do NOT fall back to email when Cognito returns no sub — the email hashes into
// the idempotency key as if it were a sub (silent corruption). Throw instead.
```

## Worked example

This is the real worst case: `infra/environments/local/main.tf` Redis block, 37 lines → 9.

BEFORE (abridged; the real block ran 37 lines): an essay covering the `cache-` prefix
reasoning, the container-name contract, the provider panic with its Go stack trace and
`ReplicationGroupAlreadyExistsFault`, the `verified 2026-08-09` date, and the subnet-group
explanation.

```hcl
# ─── Redis / ElastiCache (Users password-reset codes) ───────────────────────
# The 'cache-' prefix on context.id is load-bearing: Floci derives the
# container name floci-valkey-<id> from it, and REDIS_HOST for every
# consumer depends on that derivation staying stable across applies...
# The native aws_elasticache_replication_group resource, when run against
# Floci with the AWS provider at version 5.31.0, panics partway through
# creation with a Go stack trace ending in
# "panic: runtime error: invalid memory address or nil pointer dereference"
# after having already created the replication group in the backing
# LocalStack/Floci state, which then causes a subsequent apply to fail with
# ReplicationGroupAlreadyExistsFault because Terraform's own state was never
# updated to record the resource as created (verified 2026-08-09)...
# ... [37 lines total]
```

AFTER:
```hcl
# ─── Redis / ElastiCache (Users password-reset codes) ───────────────────────
# CONTRACT: Keep the 'cache-' prefix on context.id. Floci derives the container
# name floci-valkey-<id> from it; renaming breaks REDIS_HOST for every consumer.
# WORKAROUND(local): manage_via_provider=false. The native
# aws_elasticache_replication_group panics provider 5.31.0 against Floci and
# wedges state (group created, nothing in state). Prod keeps the default.
# WORKAROUND(local): create_subnet_group=false. Floci answers UnsupportedOperation
# for ElastiCache subnet groups; the container joins the compose network directly.
# See [[floci-elasticache-two-ports-and-provider-panic]]
```

What was preserved: the prefix requirement, the container-name contract, both flags with
their failure consequence, the prod difference, the vault pointer. What moved to the vault:
the TTL-vs-Postgres design discussion, the Go stack trace, the verification date, the AWS CLI
comparison.

## Examples by language

Verified against the linter and the vault validator this session.

Terraform (`infra/environments/local/main.tf`, 33 → 8 lines):
```hcl
# ─── DocumentDB (events-pipeline store) ─────────────────────────────────────────
# CONTRACT: Keep the "db-" prefix on context.id. Floci derives its container name
# floci-docdb-<cluster_identifier> from it, and that name is the only route to
# Mongo on 3mrai-network; renaming forces cluster REPLACEMENT.
# See [[floci-sqs-lambda-docdb-support]]
# WORKAROUND(local): manage_cluster_via_provider=false. The native aws_docdb_cluster
# gets a 403 from Floci while the identical boto3 CreateDBCluster succeeds.
# Prod keeps the default (true) and the native resources.
# See [[awscli-fallback-for-floci]]
```

C# (`services/orders/.../IEventPublisher.cs`, tags live inside `<param>`; never invent XML
pseudo-elements):
```csharp
/// <param name="email">
/// Buyer's address; the confirmation email goes here.
/// CONTRACT: Required by the ORDER_CREATED schema — an envelope without it is
/// rejected as PermanentError and no email is ever sent.
/// WARNING: PII. Never log in plaintext; hash it.
/// See [[events-pipeline-design]]
/// </param>
```

TypeScript (`WHY:` needs no reference; `CONTRACT:` requires one):
```typescript
// WHY: Redis instead of a Postgres table — the code is regenerable, single-key,
// and expires on its own, so native TTL replaces a sweeper job.

// CONTRACT: Never log a plaintext email. Auth flows log the masked form; every
// other surface uses email_hash. Unknown fields are omitted, never null.
// See [[logging-context]]
```

## Enforcement

`scripts/validate-comments.py` (Python, per [[scripting-language]]), with a
**baseline/ratchet**: existing violations are frozen in `scripts/comment-baseline.json`, CI
fails only on NEW violations, and the baseline shrinks as files are touched. This is the
standard pattern for adopting a lint rule on a legacy codebase (Betterer; Meta's automated
debt management). A repo-wide gate without the ratchet would fail on day one, which is why the
ratchet is mandatory.

Calibrated to this convention, the linter reports **987 violations across 341 files** —
`length` 874, `density` 56, `stale-term` 40, `reference` 9, `tag` 8. The baseline freezes them,
so CI reports **0 new** and exits 0. A freshly introduced 14-line block is caught as 1 new
violation.

Narrative history is not detectable by length, so the linter carries two further checks. A
**stale-term check** — comments naming decommissioned components, listed in
`scripts/comment-stale-terms.json` rather than hardcoded — is an error and freezes its existing
hits in the baseline like every other rule; it currently flags the 40 comments still naming
Jaeger. A **narrative-marker check** (95 hits) is a warning rather than an error: it runs at
roughly 90% precision at line level, and each hit needs a human to judge whether the sentence is
history or a legitimate present-tense mention. `--strict-narrative` promotes it to an error.

Judgement stays with the reviewer. The linter cannot tell whether a `CONTRACT:` really states a
prohibition *and* a concrete failure symptom, whether a `WHY:` explains a reason or narrates the
code, or whether a `See [[...]]` points at the right note.

## Migration

**Phase 0:** land this note, the linter, the baseline, and the CI gate. No code comments
change; PRs simply stop adding violations.

**Phase 1:** the ~10 worst files, as focused PRs — `infra/environments/local/main.tf`
(8 blocks, worst 37 lines), `functions/events-pipeline/emails/assets.ts` (6, worst 80),
`services/users/src/shared/messaging/event-publisher.ts` (6, worst 40),
`e2e/support/tracking-readiness.ts` (worst 49), `e2e/tests/gateway/cache.spec.ts` (worst 48).
Each moves narrative into the vault note it already duplicates.

**Phase 2:** opportunistic — touching a file means fixing its comment debt in the same PR; the
baseline shrinks monotonically.

**Grandfathering:** everything in the baseline stays until its file is touched.

## Related

- [[scripting-language]]
- [[doc-propagation]]
- [[awscli-fallback-for-floci]]
- [[floci-sqs-lambda-docdb-support]]
- [[floci-elasticache-two-ports-and-provider-panic]]
- [[logging-context]]
- [[testing]]
