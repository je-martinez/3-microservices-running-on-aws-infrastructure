# Session handoff — 2026-08-30

## Where things stand

**Branch:** `feature/tracking-go-migration`, pushed, **PR #74 open** (75 commits).
Working tree clean. `git diff --stat -- e2e/tests/` is empty — no spec was ever edited.

**Unit tests green everywhere:** events-pipeline 289, Users 535, Cognito trigger 20,
tracking-go builds and its non-DB packages pass.

**Local stack is DOWN** — the session ended with `make clean`. Run `make bootstrap`
(~4 min, exits 0) before measuring anything.

## What this session actually shipped

| Change | Effect, measured |
|---|---|
| `mapping_count=4` on the events Lambda | drain 1.02 → **3.36 ev/s**; suite 5 failures → 1-2 |
| `workers: 6 → 10` in playwright.config | 4.5 → **2.7 min**, and fewer failures |
| `PROGRESSION_INTERVAL_SECONDS` configurable, local 5s | gateway project 250 → 208s |
| `make clean` teardown moved off `terraform destroy` | minutes/hangs → **seconds**, cannot half-succeed |
| `?run_id=` scoping on Tracking's e2e-cleanup | implemented + tested, **deliberately OFF** |
| E2E email record store (earlier in session) | per-run correlation + a diagnostic that distinguishes late from lost |

## The open bug, and it is well understood

`gateway/tracking-flow.spec.ts` fails inside the full suite, passes alone.

**Root cause (proven, not theorised):** `DELETE /v1/trackings/e2e-cleanup` deletes every
E2E-tagged tracking globally. Fired while a TestMode progression is ticking, the next tick
reads `tracking_not_found` (`internal/app/progression.go:282`), the progression **aborts**,
and its remaining statuses are never published. With `workers: 10`, one run's teardown lands
inside another's live progression.

Single-variable proof: 4 trackings + no cleanup → 16/16 published. Same 4 + cleanup at
t=+17s → 12/16, **only DELIVERED missing** — the exact reported symptom.

**Why the obvious fix is already rejected:** scoping the final teardown by run id was
implemented and measured, and it made the suite WORSE (1-2 → 7 and 9 failures across paired
runs). The sweep is the only thing that clears the table, so narrowing it lets earlier runs'
rows accumulate (20 trackings deleted against 25 orders). The service-side capability is
kept and tested for a future **per-spec or per-worker** cleanup, which is where a scoped
delete belongs.

**Options not yet tried:** make the progression tolerate a deleted row and keep publishing;
serialize the teardown against live progressions; or a per-worker cleanup using the
`?run_id=` support that now exists.

## A SECOND, independent bug — still open

`tracking-flow.spec.ts:176` asserts `status === "PLACED"` on the first read. With a short
progression interval it races: **0/5 in the gateway project, 3/3 alone**. Exposed by
lowering `PROGRESSION_INTERVAL_SECONDS`, not caused by the cleanup. Fix belongs in the spec
(wait for PLACED rather than assert it), which needs approval since `e2e/tests/` is the Go
migration's equivalence evidence.

## Rules learned the hard way this session

- **Run-to-run variance is 4-15 failures on the same commit.** A single before/after run
  validates nothing. Use paired runs or a direct measurement (drain rate).
- **Never chain `make clean && make bootstrap`** in one command — each can exceed 10 minutes.
  Use a shell watchdog; macOS has no `timeout`.
- **Floci registers an event-source mapping in the API immediately but materializes its
  poller container lazily.** `list-event-source-mappings` returning 4 ≠ 4 pollers running.
- **`terraform destroy` against Floci hangs reproducibly** on a CloudWatch log group. Killing
  it half-destroys state, and hand-repairing that state produces the opposite error.

## Where the detail lives

- `docs/lessons/2026-08-30-a-global-teardown-cannot-be-scoped.md` — this investigation
- `docs/lessons/2026-08-29-the-emulator-was-the-ceiling-not-the-code.md` — the throughput one
- `spike/*.md` — four raw agent reports with the measurements
- `docs/superpowers/plans/2026-08-29-e2e-email-support-store.md` — the store's plan
