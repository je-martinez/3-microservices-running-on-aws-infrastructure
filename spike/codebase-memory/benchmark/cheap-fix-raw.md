# Cheap-fix change-impact re-measurement — raw report

**CORRECTED after team-lead follow-up.** My first pass never reached the vault
spec files that contain purpose-built "## Change impact" sections for both
questions. See "## Index-path finding" below — that is the headline result of
this run, not the content diffs.

## Index-path finding (read this first)

Team-lead's follow-up asked directly: did I open
`docs/domains/users/specs/users-service-design.md` or
`docs/domains/tracking/specs/tracking-service-design.md`? **No, neither, in the
original pass.** Checked against my own file-read list — both are absent.

My actual index-first path was:
`CLAUDE.md` (root) → `proto/users.proto` → `services/users/CLAUDE.md` +
`services/orders/CLAUDE.md` + `services/tracking/CLAUDE.md` (parallel) →
`services/tracking/scripts/generate_grpc_stubs.py` → then straight to
repo-wide grep for both questions.

I had `docs/domains/<svc>/specs/<svc>-service-design.md` in front of me — it
appeared as a **grep hit** in my very first broad search
(`grep -rl "users.proto\|proto/users"`) and is explicitly named in each
`services/<svc>/CLAUDE.md`'s own "## 6. Design reference" section (e.g.
`services/users/CLAUDE.md:126`: *"Service spec (vault):
../../docs/domains/users/specs/users-service-design.md"*). I did not follow it.
Once `services/tracking/scripts/generate_grpc_stubs.py`'s own docstring gave me
a plausible, detailed-sounding answer, I treated the CLAUDE.md tier as
sufficient and reached for grep instead of climbing one more level to the vault
spec. Same pattern on the enum question: `services/tracking/CLAUDE.md` §5d
described the event contract in general terms, and I went to grep instead of to
`docs/domains/tracking/specs/tracking-service-design.md`.

**This means the "documentation gaps" reported in my first pass were not real
content gaps** — they were gaps in my own traversal. The specs are more
complete than what I reconstructed via grep (see below).

## What the specs actually say (read in full on the follow-up pass)

### `docs/domains/users/specs/users-service-design.md`, "## Change impact —
editing `proto/users.proto`" (line 237)

Table naming **four** consumers/mechanisms, not three:
| Consumer | File | Mechanism |
|---|---|---|
| Users | `services/users/src/shared/grpc/server.ts` | runtime load via `@grpc/proto-loader`, no regen |
| Orders | `services/orders/src/Orders.Infrastructure/Orders.Infrastructure.csproj` | build-time compile |
| Tracking | `services/tracking/src/shared/grpc/generated/users_pb2.py` | committed generated stubs, must run `generate_grpc_stubs.py` |
| events-pipeline | `functions/events-pipeline/src/handlers/order-created.ts` | calls the Users gRPC surface |

Plus a `[!warning]` callout on why Tracking's committed-stub failure mode is
the one that bites silently, quoting `test_grpc_stubs.py`'s own docstring
verbatim; and a worked example of the actual field-add scenario I was asked
about (`address` on `GetUserById`) including the proto snippet, PII/x-api-key
guard callout, and the proto3-empty-string-not-null gotcha.

**This is a strictly better answer than mine.** My pass found 3 consumers
(Users, Orders, Tracking) via grep + CLAUDE.md and flagged the proto file's own
header comment as stale for omitting Tracking. The spec has all 3 **plus a 4th
(events-pipeline, `order-created.ts`)** that I did not find at all in the first
pass.

### `docs/domains/tracking/specs/tracking-service-design.md`, "## Change impact
— renaming a delivery status" (line 644)

States plainly: touches **10 files across 3 components**, crossing a service
boundary over SQS, and draws the explicit parallel to the proto-consumer
problem ("in both cases the owning service can change its contract without
anything forcing the downstream consumer to notice"). Full list:

- Tracking (owner, 6 files): `domain/status.py`, `domain/models.py`,
  `commands/update_status.py`, `commands/test_mode_progression.py`,
  `api/schemas.py`, `shared/audit/audit_actor.py`
- events-pipeline (consumer, 4 files): `src/handlers/tracking-status-changed.ts`,
  `src/handlers/index.ts`, `src/email/catalog.ts`,
  `emails/tracking-status-changed.tsx`
- E2E: `e2e/support/mailpit-client.ts`
- Plus 10 named Tracking test files that assert on status values

Plus a `[!danger]` callout that is exactly the finding I was proudest of in my
first pass (that `catalog.ts` hardcodes the mapping with no compiler/test
tripwire) — already documented, in more detail (explains WHY there's no
compile error and no failing Tracking test). Plus a fact I did not find at
all: **status values persist as strings in the DB**, so a rename is also a
data-migration question for existing rows, not just a code change.

**This is also a strictly better answer than mine.** My pass found the
events-pipeline files via grep but presented them as an undocumented gap; they
are documented, with more precision (exact file list, the `.tsx` template I
only guessed at, the DB-persistence angle I missed entirely).

## The one gap that survives: `TrackingContractTests.cs`

Per team-lead's instruction, this finding is retained because it does NOT
appear in either spec's "## Change impact" list (nor its data model /
cross-cutting sections, checked via grep for "Contract" and "SHIPPED" in the
tracking spec — no hit):

`services/orders/tests/Orders.Tests/Infrastructure/TrackingContractTests.cs`
hardcodes `"SHIPPED"` as a literal string in fixtures/assertions (confirmed via
grep, lines with `"status": "SHIPPED"` and `Assert.Equal("SHIPPED", ...)`).
Orders' `TrackingDto.Status` (`Orders.Application/Tracking/TrackingDto.cs`) is
typed as plain `string`, so a Tracking enum rename does not fail Orders at
compile time — it fails this specific test file at run time. Neither spec's
10-file / 4-consumer list for the enum-rename question, nor the proto
change-impact table, mentions this file. This is a real, narrow gap in the
tracking spec's otherwise more-complete checklist.

## Answers (revised, deferring to the specs where they are more complete)

### Q1: Adding a field to `proto/users.proto`
Authoritative answer is `docs/domains/users/specs/users-service-design.md`
lines 237–303 (see above) — 4 consumers (Users, Orders, Tracking,
events-pipeline `order-created.ts`), each by a different propagation
mechanism, plus the worked `address` field example matching this exact
question.

### Q2: Renaming a Tracking delivery-status enum value
Authoritative answer is `docs/domains/tracking/specs/tracking-service-design.md`
lines 644–678 — 10 files across 3 components (Tracking owner, events-pipeline
consumer, E2E), plus 10 Tracking test files, plus the DB-persistence
migration angle. **Add one file this spec misses:**
`services/orders/tests/Orders.Tests/Infrastructure/TrackingContractTests.cs`
(hardcoded `"SHIPPED"` literal, breaks at test time since `TrackingDto.Status`
is untyped `string`).

## Files read

**Original pass (index-first attempt):**
1. `CLAUDE.md` (repo root)
2. `proto/users.proto`
3. `services/users/CLAUDE.md`
4. `services/orders/CLAUDE.md`
5. `services/tracking/CLAUDE.md`
6. `services/tracking/scripts/generate_grpc_stubs.py`
7. `services/orders/tests/Orders.Tests/Infrastructure/TrackingContractTests.cs` (via grep, then targeted read)
8. `services/orders/src/Orders.Application/Tracking/TrackingDto.cs`
9. `functions/events-pipeline/src/handlers/index.ts`

**Follow-up pass (after team-lead's challenge):**
10. `docs/domains/users/specs/users-service-design.md` (section headers, then lines 229–303 in full)
11. `docs/domains/tracking/specs/tracking-service-design.md` (section headers, then lines 640–684 in full)

Additional paths confirmed to exist via `grep -rl`/`grep -rln` but never opened
in either pass: `services/tracking/src/shared/grpc/generated/{__init__.py,users_pb2.py}`,
`services/tracking/tests/test_grpc_stubs.py`,
`services/tracking/src/features/tracking/domain/status.py`,
`functions/events-pipeline/src/handlers/tracking-status-changed.ts`,
`functions/events-pipeline/src/email/catalog.ts`,
`functions/events-pipeline/emails/tracking-status-changed.tsx`,
`functions/events-pipeline/src/handlers/order-created.ts` (never even grep-hit
in my first pass — found only by reading the spec in the follow-up).

## Answer sources

| Question # | File(s) that answered it | Position | Pass |
|---|---|---|---|
| 1 | `proto/users.proto` comment (partial, names 2 of 4) | 2 | original |
| 1 | `services/tracking/scripts/generate_grpc_stubs.py` (partial, surfaces Tracking as 3rd) | 6 | original |
| 1 | `docs/domains/users/specs/users-service-design.md` §"Change impact" (complete, 4 of 4, plus worked example) | 10 | follow-up |
| 2 | `services/tracking/CLAUDE.md` §5d (general contract description, no file list) | 5 | original |
| 2 | repo-wide grep for the 5 enum literals (partial, found events-pipeline + Orders test file, missed DB-persistence angle) | after step 9 | original |
| 2 | `docs/domains/tracking/specs/tracking-service-design.md` §"Change impact" (complete, 10/10 files it claims, missed only `TrackingContractTests.cs`) | 11 | follow-up |

## Confidence

| Question # | Confidence | What might be missing |
|---|---|---|
| 1 | High (after follow-up) | The spec's 4-consumer table is thorough and I have no further reason to doubt it; did not independently re-verify `order-created.ts`'s exact gRPC call site line-by-line. |
| 2 | High (after follow-up) | The spec's 10-file list is thorough; the one addition (`TrackingContractTests.cs`) is grep-confirmed. Have not exhaustively re-grepped to rule out a second missed file beyond this one. |

## Index coverage

| Question # | Fully / partially / not answered | Fallback used |
|---|---|---|
| 1 | **The index (vault spec) answers this fully and precisely** — but my original traversal did not reach it. Stopped one level too early, at `services/<svc>/CLAUDE.md`, despite that file explicitly pointing to the spec under "Design reference." Fallback to grep/proto-comment-reading produced an answer that was real but incomplete (3 of 4 consumers) and wrongly characterized the proto comment's omission as the "documentation gap," when the actual index (the spec) had no such gap. |
| 2 | Same pattern. `services/tracking/CLAUDE.md` §5d describes the contract but not file-by-file; the spec one level up has the complete file-by-file answer plus context my grep fallback couldn't produce (DB persistence). Traversal stopped short again. |

## Verification

Checked in the follow-up pass: both spec files exist and contain exactly the
sections team-lead named, at the line numbers given (`## Change impact —
editing proto/users.proto` at line 237 in the users spec; `## Change impact —
renaming a delivery status` at line 644 in the tracking spec) — confirmed via
`grep -n "^## "` section listing before reading either in full.

**What the specs got right that I missed on my own:**
- `functions/events-pipeline/src/handlers/order-created.ts` as a 4th
  `proto/users.proto` consumer (Q1) — I never found this file at all.
- The DB-persistence/data-migration angle on the enum rename (Q2) — status
  values are persisted as strings in `Tracking.status` /
  `Tracking_History.status`, so a rename isn't only a code change.
- `emails/tracking-status-changed.tsx` and `src/handlers/index.ts` as
  explicit named files for Q2 — I only inferred/implicated the `.tsx` file
  without opening it.

**What the specs still miss (retained per team-lead's request):**
- `services/orders/tests/Orders.Tests/Infrastructure/TrackingContractTests.cs`
  hardcodes `"SHIPPED"` as a literal string; absent from the tracking spec's
  10-file change-impact list. Confirmed via grep in the original pass, not
  mentioned in the spec's file list (checked by re-reading the full section).

## Total distinct files read

11 (9 original pass + 2 follow-up pass)
