# E2E Email / Events-Queue Architecture Analysis

**Task:** Keep full email coverage without paying the Floci ~1 ev/s ceiling in every spec.  
**Constraints:** No weakened assertions; no raising the 45s timeliness budget; real producer → SQS → consumer → SES → Mailpit path must remain exercised somewhere.

---

## 1. Problem restatement (grounded in this repo)

### Root cause

All five failing specs share one mechanism: **queue depth**, not a broken pipeline.

| Spec | What it waits on | Failure mode |
|------|------------------|--------------|
| `gateway/delivered-emails.spec.ts:135` | OTP email in Mailpit | `waitForEmailTo` 45s timeout |
| `gateway/delivered-emails.spec.ts:191` | Welcome + order confirmation | same |
| `gateway/otp-flow.spec.ts:110` | OTP email → token exchange | same |
| `gateway/tracking-flow.spec.ts:125` | Full journey + 3 emails at end | progression or email wait |
| `gateway/realtime-tracking.spec.ts:55` | 4 WebSocket frames via pipeline | `waitForCount(4)` got 0 |

Locally, Floci's SQS→Lambda event source mapping polls about every **10s**, takes **batch_size** messages per poll, and **invocations do not overlap** — so effective throughput is ~**batch_size / poll_interval** (measured ~0.86–1.00 ev/s at `batch_size=10`). The handler already processes records concurrently inside a batch (`Promise.allSettled` in `functions/events-pipeline/src/handler.ts:541`), but the next poll cannot start until the current invocation finishes.

A full E2E run publishes on the order of **~420 events** (~**286** are `USER_CREATED` welcome mails from registrations). Only **three specs** ever assert on the welcome email (`delivered-emails` welcome test, `tracking-flow` step 7, and indirectly via inbox filtering in passwordless OTP). The other ~283 welcome events are **pure queue noise**.

The existing `email` Playwright project (`playwright.config.ts:190–238`) serializes the OTP/password-reset/delivered-email specs (`workers: 1`, `fullyParallel: false`) and measurably helps — but **`tracking-flow.spec.ts` and `realtime-tracking.spec.ts` are not in it**. They run in the `gateway` project with **10 parallel workers**, competing for the same queue while publishing their own `USER_CREATED`, `ORDER_CREATED`, and `TRACKING_STATUS_CHANGED` events.

`e2e/CLAUDE.md` §4 and `support/email-store-client.ts` are explicit: **specs must still wait for and assert the real Mailpit message**. The record store is diagnostic only.

---

## 2. What already exists (do not rebuild)

| Layer | Location | What it proves |
|-------|----------|----------------|
| Producer unit tests | `services/users/tests/shared/messaging/sqs-event-publisher.test.ts`, Orders `SqsEventPublisherTests.cs` | Envelope shape the producer *intends* |
| Consumer unit/handler tests | `functions/events-pipeline/tests/**` (26 files) | Dispatch, render, SES call, Zod validation |
| Cross-boundary guard (one event type) | `services/tracking-go/internal/adapter/sqs/zod_contract_test.go` | Go envelope vs real Zod schema on disk |
| Template preview | `e2e/tests/email-templates.spec.ts` | Component renders with `sampleProps` — **not** delivery |
| Serialized email project | `playwright.config.ts` `email` project | Reduces contention among OTP/reset/delivered specs |
| Queue warning | `support/global-setup.ts` + `events-queue-depth.ts` | Warns when depth > 25; does not block |

Lesson `docs/lessons/2026-08-27-a-producer-side-test-proves-nothing-about-what-the-consumer-accepts.md` and `delivered-emails.spec.ts` header both state why preview/producer tests cannot replace inbox assertions.

---

## 3. Option evaluations

### Option A — Contract testing at the producer/consumer boundary

**Idea:** Expand schema-driven guards (like `zod_contract_test.go`) for every event type and every producer (Users, Orders, Tracking, Cognito OTP trigger). Run in `make test-unit` / CI without the stack.

| | |
|---|---|
| **What it buys** | Fast detection of wire-shape bugs (the `shipping_address` string-vs-object incident). Safe deploy ordering when schemas tighten. Removes *schema* failures from the E2E queue. |
| **Coverage it loses** | If used *instead of* Mailpit waits: SES relay fidelity, real event payloads from live services, Cognito→SQS OTP path, 45s timeliness, branded HTML from *this run's* data (`delivered-emails.spec.ts` documents this). |
| **Files to change** | **~6–12:** add guards in Users/Orders (TS/C#), mirror pattern for `AUTH_OTP_REQUESTED` / `PASSWORD_RESET_REQUESTED`; optional shared JSON Schema artifact + generator (**+3–5** infra). No E2E spec changes if additive. |
| **SOLVES or HIDES?** | **SOLVES** schema drift **in parallel** with E2E. **HIDES** the problem if Mailpit assertions are dropped or replaced by the email record store (forbidden by `e2e/CLAUDE.md` §4). |

**Verdict:** Necessary **complement**, not a substitute for full-path tests. Does not address queue depth by itself.

---

### Option B — Run the consumer as a plain process (not emulated Lambda) for tests

**Idea:** Add a compose `events-pipeline-worker` (or test profile) that long-polls SQS in a tight loop using the **same** `handler.ts` bundle, bypassing Floci's 10s poll cadence. `docker-compose.yml` deliberately has **no** such service today (lines 398–403): the real Lambda exercises event source mapping, batching, and partial batch responses.

| | |
|---|---|
| **What it buys** | Local drain rate could approach record processing time (~0.3–2s/ev) instead of ~10s/poll. Full suite backlog drops from **minutes** to **seconds**. All specs could keep 45s budgets on a cold queue. |
| **Coverage it loses** | Lambda-specific behavior: cold start, `batch_size=10` batching policy, partial `batchItemFailures`, concurrent Lambda scaling (already capped at ~2 containers locally). Production still scales per batch — this option does not emulate prod throughput either, it only fixes *local* starvation. |
| **Files to change** | **~8–15:** new compose service + entry script (`functions/events-pipeline/scripts/poll-worker.ts` or reuse handler), Makefile/`bootstrap` profile toggle, Terraform or env flag to disable Floci ESM during E2E, docs. Risk of **two local paths** drifting unless both invoke identical `dist/handler.js`. |
| **SOLVES or HIDES?** | **SOLVES** the measured local ceiling (honest fix for Floci limitation). **Does not hide** delivery if SES→Mailpit unchanged. **Partially hides** Lambda operational semantics — acceptable for E2E if a **nightly** job still runs against real Floci Lambda (slower, serialized). |

**Verdict:** Strong fix for local throughput; higher implementation cost and operational duality. Pair with Option D/C so it is not the first lever.

---

### Option C — Fast PR tier + slow nightly tier

**Idea:** Split Playwright runs: PR runs fast, non-contending subset; nightly (or pre-merge) runs full serialized pipeline suite.

| Tier | Suggested contents |
|------|-------------------|
| **PR fast** | All specs that do **not** wait on Mailpit or WebSocket pipeline; **one** canonical full-path smoke (e.g. `gateway/otp-flow.spec.ts` happy path only) in a serialized `pipeline` project. |
| **Nightly full** | Current `email` project + `tracking-flow` + `realtime-tracking` + `delivered-emails` + internal OTP/reset; `workers: 1` for entire gateway run or dedicated `pipeline` project; optional queue drain wait in `global-setup`. |

| | |
|---|---|
| **What it buys** | PR feedback in ~2–3 min without 10–15 flaky timeouts. Full coverage + 45s timeliness preserved on a schedule. |
| **Coverage it loses (PR tier)** | Regressions in non-smoke email templates (welcome HTML branding, tracking DELIVERED subject, password-reset) until nightly runs. Gallery screenshots (`delivered-emails`) may only run nightly. |
| **Files to change** | **~4–6:** `playwright.config.ts` (tags/projects), `Makefile` (`test-e2e` / `test-e2e-full`), CI workflow if present, `package.json` scripts. |
| **SOLVES or HIDES?** | **HIDES** for PR if email specs are skipped entirely. **SOLVES** as a **schedule** if PR still runs ≥1 real Mailpit assertion with 45s budget and nightly runs everything. Does not fix root cause — **works around** contention. |

**Verdict:** Good governance layer **on top of** serialization/noise reduction, not alone.

---

### Option D — Reduce the ~286 unnecessary `USER_CREATED` events

**Idea:** Stop enqueueing welcome emails that no spec will ever wait for.

| Sub-approach | Mechanism | Files | Assessment |
|--------------|-----------|-------|------------|
| **D1 — Serialize all pipeline specs** | Move `tracking-flow`, `realtime-tracking` into `email`/`pipeline` project (`workers: 1`) | **1** (`playwright.config.ts`) | **Best first move.** No assertion change. Cuts *contention*, not publish count. |
| **D2 — Reuse auth per `describe`** | `beforeAll` register once per file instead of `getGatewayToken()` per test | **~10–15** spec/support files | Cuts registrations ~2–5× per file. Isolation risk if tests mutate same user; fine for read-heavy gateway specs. |
| **D3 — Suppress `USER_CREATED` when `E2E_TESTING_ENABLED` + header** | Skip publish in `register.ts` unless spec opts in | **~4–6** service + tests | **HIDES** welcome path for most runs unless opt-in spec covers it. Product behavior change. |
| **D4 — Global single user** | One shared Cognito user for all non-auth specs | **~20+** | **HIDES** per-user isolation; breaks parallel safety. Not recommended. |

| | |
|---|---|
| **What D1+D2 buys** | D1: failures drop from contention (measured: serialized email project 10 failed vs 11 without). D2: could remove **~150–200** queue events if half of `getGatewayToken()` calls become reuse (~3–4 min drain saved). |
| **Coverage it loses** | D2: only if tests share state incorrectly. D3: welcome email path for suppressed registrations. |
| **SOLVES or HIDES?** | **D1 SOLVES** contention. **D2 SOLVES** noise (mostly). **D3 HIDES** unless tightly gated to "welcome not under test." |

**Verdict:** **D1 immediately** (config-only). **D2 selectively** in high-churn files (`gateway/tracking.spec.ts` has 9× `getGatewayToken`). Do **not** suppress `USER_CREATED` in production code paths.

---

## 4. Recommended architecture (layered)

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1 — Unit / contract (no stack, every PR)                  │
│  • Expand zod_contract guards: Users, Orders, OTP envelope      │
│  • events-pipeline handler + sender.integration tests           │
│  • Catches wire bugs; does NOT replace Mailpit                  │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│ Layer 2 — PR E2E fast (make bootstrap)                        │
│  • Parallel: all non-pipeline specs (current internal+gateway)  │
│  • Serialized `pipeline` project (workers:1):                     │
│      - otp-flow (happy path)  ← canonical 45s timeliness check  │
│      - optionally password-reset-flow happy path                │
│  • No delivered-emails gallery; no tracking-flow (~3 min)     │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│ Layer 3 — Full E2E / nightly (serialized pipeline queue)        │
│  • All current `email` specs + tracking-flow + realtime-tracking│
│  • delivered-emails (OTP + welcome + order HTML artifacts)      │
│  • workers:1 for entire pipeline-dependent set                │
│  • global-setup: warn if depth>25; optional drain-or-fail gate  │
│    for nightly only                                             │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│ Layer 4 — Optional infra (if Layer 3 still flaky)               │
│  • E2E profile: compose SQS long-poll worker, same handler dist │
│  • Nightly job B: full suite against real Floci Lambda ESM      │
└─────────────────────────────────────────────────────────────────┘
```

### Why this satisfies the hard constraints

1. **No weakened assertions** — every email spec keeps `waitForEmailTo` / `getMessage` / HTML content checks unchanged.
2. **45s budget preserved** — at least `otp-flow` on every PR; full set on nightly.
3. **Real path exercised** — smoke + nightly use live services → SQS → Lambda → SES → Mailpit; contract tests do not replace that.

### Mapping to the five failing specs

| Spec | Fix under recommended stack |
|------|----------------------------|
| `otp-flow.spec.ts:110` | Already in `email` project; ensure full PR/nightly runs use `workers:1` for pipeline group |
| `delivered-emails.spec.ts` | Nightly/full tier only (or extend pipeline project); serialized |
| `tracking-flow.spec.ts:125` | **Add to pipeline project** + serialized; D2 reuse only within second test in same file |
| `realtime-tracking.spec.ts:55` | **Add to pipeline project**; WebSocket waits same queue as email |

---

## 5. What explicitly does NOT work

| Approach | Why rejected |
|----------|--------------|
| Raise `EMAIL_TIMEOUT_MS` above 45s | Violates constraint; masks timeliness; prod Lambda scales |
| Assert via `email-store-client` only | Forbidden — stops proving delivery |
| `email-templates.spec.ts` instead of `delivered-emails` | Proves catalog samples, not relayed bytes |
| Purge Mailpit mid-run | Documented race — deletes concurrent worker mail |
| Rely on producer tests only | Lesson 2026-08-27; silent `transient: false` drops |
| Run load tests before E2E | Documented — leaves ~800 message backlog |

---

## 6. Effort summary

| Option | Files (order of magnitude) | Solves root cause? | Keep full email coverage? |
|--------|---------------------------|--------------------|---------------------------|
| A — Contract tests | 6–12 | Schema only | Yes, if additive |
| B — Plain consumer process | 8–15 | **Yes** (local throughput) | Yes |
| C — PR / nightly tiers | 4–6 | No (schedules around) | Yes, on nightly |
| D1 — Extend serialized project | **1** | Contention **yes** | Yes |
| D2 — Auth reuse | 10–15 | Partial (noise) | Yes |
| **Recommended bundle (D1 + C + A)** | **~12–20** | Contention + schema | **Yes** |

---

## 7. Immediate next step (smallest change with highest impact)

**Extend `playwright.config.ts` `email` project** (or rename to `pipeline`) to include:

- `**/gateway/tracking-flow.spec.ts`
- `**/gateway/realtime-tracking.spec.ts`

Keep `workers: 1`, `fullyParallel: false`. No assertion changes. Re-run full suite and expect the five failures to clear or drop sharply when queue depth stays below `EVENTS_QUEUE_WARN_DEPTH` (25).

If failures persist, apply **D2** to `gateway/tracking.spec.ts` and `gateway/orders.spec.ts` (highest `getGatewayToken()` counts), then consider **Layer 4** (plain poll worker) only if serialized full suite still exceeds practical CI time.
