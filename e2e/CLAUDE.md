# CLAUDE.md — E2E and load testing

Nested project memory for the **testing surface**: the Playwright E2E suite and
the Gatling JS load simulations. Source of truth for their stack and
conventions. The `e2e-impl` agent reads this first, every time. Cross-cutting
rules are **referenced**, never duplicated.

## 1. Two suites, two different jobs

| | Playwright (`tests/`) | Gatling JS (`load-tests/`) |
|---|---|---|
| Question it answers | "is it correct?" | "what shape does it have under load?" |
| Volume | a handful of requests per spec | sustained traffic for minutes |
| Verdict | assertions on behaviour | percentiles, throughput, error rate |
| Data | tagged and torn down | persists like real data |

They are **not** interchangeable, and the most common mistake is reading one as
the other: percentiles over four E2E requests are noise, and a load run proves
nothing about correctness beyond status codes.

## 2. Stack & commands

Run `nvm use` first (repo pins Node **24.18.0**), and **pnpm only** — never npm
(see [[package-manager]]).

**Playwright** (`e2e/`):
- Test: `pnpm --filter @3mrai/e2e test` · Typecheck: `pnpm --filter @3mrai/e2e typecheck`
- Needs the stack up: `make bootstrap`.
- Two projects in `playwright.config.ts`: **internal** (`tests/`, hits service
  URLs directly, `x-user-id` faked) and **gateway** (`tests/gateway/`, real
  Cognito JWT through `API_GATEWAY_URL`).
- `support/global-setup.ts` / `global-teardown.ts` run once around everything.

**Gatling** (`e2e/load-tests/`):
- `pnpm run smoke` (~30s sanity) · `pnpm run load` · `pnpm run users` ·
  `pnpm run auth-codes` · `pnpm run cache-ab` (the cache A/B; drive it via
  `make load-test-cache-ab-on` / `-off`, which flip `CACHE_ENABLED` and restart
  the services for you — then `make cache-toggle V=true` to restore, or every
  cache spec fails with "no X-Cache header at all")
- **No JDK.** The CLI downloads its own runtime into `~/.gatling/`.
- Tune any profile without editing a file:
  `pnpm exec gatling run --typescript --simulation fullJourney usersPerSec=5 duration=600`
- Full conventions and the traps that cost real debugging time: the `gatling-js`
  skill (`.claude/skills/gatling-js/`). Read it before writing a `.gatling.ts`.

## 3. The three test layers

Convention: [../docs/shared/conventions/testing.md](../docs/shared/conventions/testing.md) → [[testing]].

Every HTTP endpoint needs all three: (1) unit/integration in the service, (2)
internal E2E here, (3) **gateway E2E with a real Cognito JWT**. Layers 1 and 2
fake the authorizer and cannot catch gateway-only bugs — a missing route, a
dropped path param, a method mismatch. **An endpoint without a gateway spec is
an incomplete change.**

## 4. E2E-only headers — and why load tests must NOT send them

Two headers exist purely for testing, and the distinction between the suites
turns on them:

- **`x-e2e-source: true`** tags rows so `e2e-cleanup` can delete exactly what a
  run created. Applied at creation **only when the flag `E2E_TESTING_ENABLED` is
  also on** — the conjunction is what stops an untrusted client tagging rows for
  someone else's teardown to delete.
- **`x-test-mode: true`** (on order creation) makes a tracking advance itself
  every 10s to DELIVERED, so a delivery flow can be asserted in 40 seconds.
- **`x-e2e-run-id`** attributes every email a request causes to THIS invocation,
  so the pipeline's fixture collection can be read per run instead of blindly
  across workers and reruns. Minted once in `support/global-setup.ts` and passed
  to the workers through the environment (they are separate processes, so a
  module constant would give each worker its own id). Same conjunction rule as
  the two above: honored only when the receiving service has
  `E2E_TESTING_ENABLED`. On the OTP path it rides Cognito's `ClientMetadata` —
  the only caller-controlled field Cognito forwards to a trigger verbatim, and
  the same seam `traceparent` already uses.
- **Run-id scoping on teardown (Tracking only).** Rows the harness creates can
  carry a second tag, `"E2E Run <run_id>"`, so `DELETE /v1/trackings/e2e-cleanup`
  can require BOTH `"E2E Source"` and that run tag instead of sweeping every
  E2E-tagged row globally. `support/global-teardown.ts` passes
  `?run_id=<E2E_RUN_ID>` when the id is present and valid; without one (an
  internal-only run, or manual teardown) the call stays unscoped and deletes
  everything tagged `"E2E Source"`, exactly as before. That fallback matters for
  load tests and ad-hoc cleanup. Orders and Users teardown stay unscoped — they
  have no in-process progression that dies when another run's sweep deletes a
  row mid-flight (Tracking's TestMode goroutine does, which is why only Tracking
  needed this).

**Load simulations send neither**, deliberately:
- Load data is meant to persist like real data, so it is **not** cleaned up —
  reset with `make clean && make bootstrap`.
- Without `x-test-mode` a tracking does not advance on its own, which is why the
  simulation drives it through the **carrier webhook** — the way a real carrier
  does.

### Do not run a load simulation and the E2E suite against the same stack

Not a style preference — it makes **every email-asserting spec fail**, and the
failure looks exactly like a broken pipeline. Diagnosed 2026-08-25, after five
E2E failures (4× OTP/password-reset, 1× tracking DELIVERED) that were all this.

The mechanism, because the rule alone is not enough to recognise it:

- A load run publishes several hundred `loadtest-*` events onto the **shared**
  SQS queue — the same one Users, Orders and Tracking use.
- The events-pipeline Lambda drains it at **~1 msg/s**. Records are processed
  **sequentially** (`for (const record of event.Records)` in
  `functions/events-pipeline/src/handler.ts`), ~**376 ms** each (p50 347, p95
  574, over 920 records), dominated by the react-email render on a **256 MB**
  function — Lambda CPU scales with memory.
- So an OTP, reset or DELIVERED event published behind ~800 messages waits
  **~13 minutes**, while every spec awaiting an email gives up after **45 s**.

**The emails are not lost — they arrive far too late.** This is the part worth
remembering: `waitForEmailTo` fails with *"NOTHING arrived"*, which reads as a
broken pipeline and sends you hunting a defect in dispatch, SES or Mailpit. All
three are fine. Verified by re-running the same specs with no code change:

| Queue depth | Result |
|---|---|
| ~800 | 2 failed — "NOTHING arrived within 45s" |
| 0 | **14/14 passed**, emails in **13 s** |

Measured drain, sampled live: `827 → 727 → 567 → 417 → 237 → 0` over ~18 min,
a steady ~50 msg/min.

`support/global-setup.ts` **warns** (never fails — it cannot tell an
email-asserting run from the majority of specs that never touch the pipeline)
when the queue is deeper than `EVENTS_QUEUE_WARN_DEPTH`; the threshold's
arithmetic lives in `support/events-queue-depth.ts`. If you see that warning,
wait for the queue to drain or reset with `make clean && make bootstrap`.

### The email record store — a diagnostic channel, never an assertion channel

`support/email-store-client.ts` reads back what the events-pipeline recorded for
the current run (see `functions/events-pipeline/CLAUDE.md` §3c), over the events
Lambda's Function URL.

**The rule, and it is not negotiable: specs still wait for and assert the REAL
email.** A spec that reads its OTP out of this store instead of the message stops
proving delivery end to end, and a green suite bought that way is worse than a
red one. Deleting every use of this client must leave the suite still proving
email delivery.

What it adds is the one fact a bare "nothing arrived in 45s" cannot supply:

| store says | what it proves | where to look |
|---|---|---|
| recorded | the pipeline **did** render and send it — the failure is delivery timing. **Conclusive.** | Floci's ~1 ev/s ceiling, [[2026-08-29-the-emulator-was-the-ceiling-not-the-code]] |
| nothing recorded | **"not yet", not "never"** — inconclusive alone | the events queue depth: non-zero = late, zero = genuinely lost |

The asymmetry is the point, and it was learned the hard way. The store is written
**after** the send, so a backlog delays the RECORD exactly as it delays the mail:
on a cold run a spec timed out at 45s and its OTP was recorded at **2m25s** —
real, and simply later than anyone was looking. An earlier version of this
message concluded "the pipeline never rendered one", which is the opposite of the
truth and sends the reader hunting a defect that does not exist.

`describeRecordedEmails(address)` returns that verdict as a block to append to a
failure message; `otp.spec.ts` and `gateway/otp-flow.spec.ts` wrap their email
wait with it. The client **cannot fail a test** — missing config disables it, any
error returns empty, and it catches its own failures, because a diagnostic that
throws would replace a clear timing failure with a confusing connection error.

## 5. Auth surfaces

- **Gateway specs** get a real token via `support/auth.ts` (register + login
  through the gateway). Note it sends `X-E2E-Source`, so it is **not** reusable
  by load tests.
- **The carrier webhook** (`PUT /v1/trackings/{orderId}/status`) authenticates
  with `TRACKING_CARRIER_API_KEY` — an **external vendor's** credential, a
  different secret from the internal `GRPC_API_KEY`. Never substitute one for
  the other.
- **Each virtual user needs its own token.** A shared one collapses every
  user-scoped read onto a single `cognito_sub` and hides the per-user query
  cost the dashboards exist to show.

## 6. Writing load simulations — what cost time here

These were all measured, not guessed:

- **`session.userId()`, never a module-level counter**, for anything that must
  be unique per virtual user. Simulation modules are evaluated per execution
  context in GraalVM, so module scope is not one shared sequence — a counter
  produced the *same* email five times in one run. The cascade is what makes it
  expensive: a duplicate email 409s registration, the login then fails, and
  every authenticated step after it 401s, so one data bug reads as a broken
  auth chain.
- **`process.env` does not exist** in a simulation — use `getEnvironmentVariable`
  / `getParameter` from `@gatling.io/core`. With `@types/node` present the
  former type-checks and then dies at runtime.
- **A 409 on order creation is expected under load.** Creation locks each
  product row `FOR UPDATE`, so concurrent buyers genuinely contend. Accept
  201-or-409 and guard the steps that need an order id, or one contention event
  cascades into five derived failures.
- **Isolate slow dependencies behind their own request name.** The OTP/reset
  flows wait on an email (service → SQS → Lambda → SES → Mailpit, seconds). The
  poll is named `GET mailpit (wait for code)` so it holds its own row and never
  smears the service's real latency — verified: `otp/start` answers in ~26ms
  while the inbox wait runs into seconds.
- **Assert only on our own endpoints.** Holding a third party's latency to a
  budget fails the run for something the simulation does not measure.

## 7. Agent rules

- **ASK the user before running anything that opens a browser window** — the full
  suite and one-off probes alike — and wait for a yes. Four web specs are headed
  on purpose (`cart-drawer-animation`, `popover-overflow`, `scrollbar-gutter`,
  `cart-drawer-first-open`): headless draws overlay scrollbars, so a width-shift
  regression measures clean there. They launch through
  `support/web-browser.ts`, which places the window on the display the user
  chose; never call `chromium.launch` directly. Convention:
  [../docs/shared/conventions/headed-browser-consent.md](../docs/shared/conventions/headed-browser-consent.md).

- Converse with the user in **Spanish**; write code and comments in **English**.
- `e2e-impl` writes **only test/simulation code** — never runs git, never
  touches Linear. Leave the work in the working tree for the main session.
- Stay within the single task handed to you (YAGNI).

## 8. Design reference

- Testing convention: [../docs/shared/conventions/testing.md](../docs/shared/conventions/testing.md)
- Code comments: [../docs/shared/conventions/code-comments.md](../docs/shared/conventions/code-comments.md) → [[code-comments]]
- Load-test README: [load-tests/README.md](load-tests/README.md)
- Gatling conventions: `.claude/skills/gatling-js/SKILL.md`
- The metrics these runs are meant to make readable:
  `docs/superpowers/specs/2026-08-12-custom-business-metrics-cloudwatch-design.md`
