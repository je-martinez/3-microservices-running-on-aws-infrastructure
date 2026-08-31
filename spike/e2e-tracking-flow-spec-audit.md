# tracking-flow.spec.ts — spec-fault audit

**Task:** Decide whether `e2e/tests/gateway/tracking-flow.spec.ts` is partly at fault for the intermittent full-suite failure where tracking reaches DELIVERED and the processing email arrives, but the delivered email does not.

**Date:** 2026-08-30

## Verdict

**Partly at fault for parallel-suite flakes; not the root cause of the measured SQS-loss email failure.**

The spec has one **reproducible timing bug** (PLACED-at-first-read) that fails consistently when the test runs inside the `gateway` project with 10 workers. That bug was introduced or exposed by the **5 s progression cadence** — the window between order creation and the first successful tracking read is now often longer than one progression tick.

The **described email failure** (DELIVERED on the API, processing email in Mailpit, no delivered email, pipeline never saw the event, SQS depth 0) is **not explained by spec logic**. The spec does not assume emails arrive in order, Mailpit search is correctly encoded, and timeouts are generous enough for 5 s cadence. That symptom points at production code (publish-before-confirm, silent send failure, or inter-hop drop), not at a wrong assertion.

---

## Checklist (from brief)

| Question | Answer |
|---|---|
| Does it assume the four status emails arrive **in order**? | **No.** Comments (L248–250) state the opposite. Step 7 uses `minCount: 3` (welcome + order + ≥1 tracking), then `findBySubject` for the delivered subject only. It does not require all five tracking emails or any ordering among them. |
| Is `DELIVERY_TIMEOUT_MS = 90_000` too short for 5 s cadence? | **No.** Comments still say 10 s / ~40 s (stale), but 5 s × 4 transitions ≈ 20 s; 90 s is ample. `EMAIL_TIMEOUT_MS = 45_000` is also sufficient when the queue is empty (emails arrive in ~2–13 s locally). |
| Mailpit `+` encoding trap? | **Not a factor.** `searchByRecipient` uses `encodeURIComponent(\`to:${address}\`)` (mailpit-client.ts L79–84). The spec never builds queries itself. |
| Shared user / order / product with parallel specs? | **No cross-run contamination.** `makeUser()` uses `e2e+${crypto.randomUUID()}@example.com`. Each run owns its order and inbox. The product catalogue is shared, but stock contention causes 409s on order creation, not email mis-association. |
| `email` project vs 10 workers? | **`tracking-flow` runs in `gateway`, not `email`.** `playwright.config.ts` puts only otp/password-reset/delivered-emails in the serialized `email` project (`workers: 1`). The journey spec runs with **10 local workers** alongside ~50 other gateway specs, including `realtime-tracking.spec.ts` (also `x-test-mode: true`). |

---

## Measured pass rates (this session, same commit, stack up)

| Run configuration | Main journey test (`:125`) | Notes |
|---|---|---|
| Alone × 3 | **3/3 pass** (~27 s each) | Stable |
| `gateway` project × 5 | **0/5 pass** | **Every failure at L176:** `Expected: "PLACED"`, `Received: "PROCESSING"` (~7–13 s) |
| Alone × 3 (after gateway runs) | **3/3 pass** | Isolation still green |

The gateway-project failure is **not** the delivered-email assertion. It dies on the first tracking read because `waitForTracking` only waits for HTTP 200, not for `status === "PLACED"`. Under parallel load, init-tracking + first successful GET often takes **> 5 s**, so the first observable status is already PROCESSING.

---

## Spec weaknesses (proposed fixes — do not edit equivalence specs without approval)

### 1. PLACED-at-first-read race (HIGH — reproduces 5/5 in gateway project)

**Current code (L171–178):** `waitForTracking` returns on first 200, then `expect(tracking.status).toBe("PLACED")`.

**Problem:** With `PROGRESSION_INTERVAL_SECONDS=5`, the test-mode goroutine can advance PLACED → PROCESSING before the spec's first read. The **history** still starts at PLACED; the **current status** does not have to be PLACED.

**Proposed change:** Drop the current-status PLACED assertion at first read. Assert `tracking.history[0].status === "PLACED"` and that history length ≥ 1. Alternatively, extend `waitForTracking` with an optional `expectedStatus` or poll until status is PLACED (wasteful under 5 s cadence).

### 2. `minCount: 3` does not wait for the delivered email (LOW for measured loss; MEDIUM for queue backlog)

**Current code (L251–255):** `waitForEmailTo(email, { minCount: 3, timeoutMs: 45_000 })`, then `findBySubject(inbox, deliveredSubject)`.

**Problem:** Once welcome + order + **any** tracking email (e.g. processing) arrive, polling stops and returns the inbox snapshot. If the delivered email is still in the queue (backlog), `findBySubject` fails even though delivery would succeed seconds later.

**Why this is not the measured failure:** Coordinator facts: SQS depth 0 after run, pipeline never ingested the event, tracking logged publish. That is **loss**, not a 45 s timeout or early return.

**Proposed change:** Wait for the delivered subject explicitly:

```ts
const deliveredSubject = `Order ${order.id}: delivered`;
await waitForEmailTo(email, {
  matching: (m) => m.Subject === deliveredSubject,
  timeoutMs: EMAIL_TIMEOUT_MS,
  description: `the "${deliveredSubject}" email`,
});
// separately wait for welcome + order if still needed
```

Or keep `minCount` but add `matching` that requires the delivered subject among the set.

### 3. Stale comments (cosmetic)

L36–38, L43–44, L126 still describe **10 s** cadence and **~40 s** progression. Update to **5 s / ~20 s** when the spec is next touched.

### 4. Missing email-store diagnostic (cosmetic)

`otp-flow.spec.ts` wraps `waitForEmailTo` failures with `describeRecordedEmails`. This spec does not. Adding that would not fix flakes but would separate "pipeline never rendered" from "rendered but not in Mailpit" on timing failures.

---

## What the spec gets right

- **End-to-end contract:** Gateway-only path, `x-test-mode` on Orders, sub→`usr_` resolution, poll to DELIVERED, then pipeline email proof.
- **No email ordering assumption** for welcome vs order vs tracking.
- **Correct delivered subject** (`Order ${order.id}: delivered`) matching the handler.
- **Unique inbox per run** — no hardcoded addresses.
- **Bounded timeouts** — appropriate for local stack when queue is healthy.
- **History assertions after DELIVERED** (L199–222) are sound and independent of first-read timing.

---

## Conclusion for production-code investigation

If the full-suite failure matches the coordinator's measured facts (API at DELIVERED, processing email present, delivered email absent, pipeline/SQS never saw the event), **the spec is not inventing that failure.** Investigate Tracking publish semantics (`tracking_status_changed_published` before SQS ack), silent send failures, and inter-service drops.

If failures instead show **PLACED vs PROCESSING at L176** (~7 s, gateway parallel), **fix the spec first** — that is a test assumption the system never promised (that you always observe PLACED as the live status on first read).
