---
trigger: manual
---

# Testing — three layers per endpoint

Every new or changed HTTP endpoint requires **all three** layers before it is
done:

1. **Unit / integration** — the handler and its collaborators.
2. **Internal E2E** — against the service URL directly.
3. **Gateway E2E with a real Cognito JWT** — the URL the user actually hits.

## Why the third layer is not optional

In-process and internal tests fake the authorizer and never touch the API
gateway, so they cannot see gateway-only bugs:

- a route that was never registered on the gateway
- a path parameter dropped in the gateway mapping
- an HTTP method mismatch between gateway and service

An endpoint without gateway E2E is an **incomplete change**, not a change
pending a nice-to-have.

Per-service specifics live in each `services/<svc>/CLAUDE.md` (or the equivalent
service instruction file), section 2b.

## A NEW ROUTE IS NOT DONE WHEN THE SERVICE SERVES IT

A plan that adds an endpoint must carry a task for **each** item below, or state
why one does not apply. Every one of them was missed at least once (cart
milestone, 2026-08-25) and each was caught late — or nearly not at all.

### Gateway + nginx wiring

Two separate places route a request before it reaches your handler, and neither
fails loudly:

- A route absent from the gateway's route map
  (`infra/modules/api-gateway/main.tf`) **404s at the gateway** while working
  perfectly on the service port.
- Without a `location` block in `infra/modules/compute/nginx/nginx.conf`, a new
  top-level path falls through to `location /` and silently reaches **Users** —
  not the service that owns it. It answers; it is simply the wrong service.

**Diagnostic:** a 404 carrying the gateway's own `{"message":"Not Found"}` body,
rather than the service's `{error: …}` shape, means the request never reached the
service at all. Read the body, not just the status.

**After the fix, a 401 is the good answer.** It proves the route resolves and got
as far as the authorizer. Do not read it as a regression.

### All three test layers, not two

**Internal E2E is the one quietly skipped**, because the gateway spec feels like
it covers the same ground. It does not: the gateway spec is slower and should not
carry the exhaustive cases, so dropping the internal layer silently drops the
exhaustive coverage with it.

### Load-test scenarios

Required when the route changes how users reach an **existing** flow — a new
entry point to a covered journey leaves the old simulation measuring a path real
users no longer take.

### Observability

Every endpoint owes a workflow span and at least one flow log. **Reads are not
exempt** — see `.ai/rules/logging-and-pii.md`, "Which endpoints owe a flow log".

### Preview surfaces and rounding

A preview surface must mirror **how the charging code applies rounding**, not
merely how it rounds. Matching the rounding function while applying it at a
different point (per line vs. per total) still quotes a price the charge will not
match. See `docs/shared/conventions/money-representation.md`.

## Load testing is a fourth, different surface

Load tests live in `e2e/load-tests/` (Gatling JS + Chance.js), beside the
Playwright suite in `e2e/`. They answer a **different question**: not "is it
correct?" but "what shape does it have under sustained traffic?".

They are **not** interchangeable with E2E specs, and reading one as the other is
the common mistake — percentiles over four E2E requests are noise, and a load run
proves nothing about correctness beyond status codes.

### The two E2E-only headers, and why load tests omit them

- **`x-e2e-source: true`** tags rows so cleanup can delete exactly what a run
  created. It only takes effect when the flag `E2E_TESTING_ENABLED` is **also**
  on — that conjunction is what stops an untrusted client tagging someone else's
  rows for deletion.
- **`x-test-mode: true`** (on order creation) makes a tracking advance itself
  every 10s to DELIVERED, so a delivery flow can be asserted in ~40 seconds.

**Load simulations deliberately send neither.** Their data is meant to persist
like real data (reset with `make clean && make bootstrap`, not a cleanup pass),
and without `x-test-mode` a tracking does not self-advance — which is why a
simulation drives it through the **carrier webhook**, the way a real carrier
does.

### Load-simulation traps (measured, not guessed)

- **Use `session.userId()`, never a module-level counter**, for anything that
  must be unique per virtual user. Simulation modules are evaluated per execution
  context, so module scope is not one shared sequence — a counter produced the
  *same* email five times in one run. The cascade is what makes it expensive: a
  duplicate email 409s registration, login then fails, and every authenticated
  step after it 401s, so one data bug reads as a broken auth chain.
- **`process.env` does not exist** in a simulation — use
  `getEnvironmentVariable` / `getParameter` from `@gatling.io/core`. With
  `@types/node` present the former type-checks and then dies at runtime.
- **A 409 on order creation is expected under load** — creation locks each
  product row `FOR UPDATE`, so concurrent buyers genuinely contend. Accept
  201-or-409 and guard the steps needing an order id.
- **Give each virtual user its own token.** A shared one collapses every
  user-scoped read onto a single `cognito_sub` and hides the per-user query cost.
- **Isolate slow dependencies behind their own request name**, so an inbox poll
  measured in seconds never smears a service's real ~26ms latency.
- **Assert only on our own endpoints** — holding a third party's latency to a
  budget fails the run for something the simulation does not measure.

## Mocks hide schema bugs

Mocked unit tests pass happily while the real schema or driver rejects the
write. Verify persistence paths against a live database, not only a mock.

## Assertions must name what they saw

Count-only assertions ("got 3 of 4") cannot distinguish a broken system from a
wrong expectation. Print **what** arrived, not just how many.