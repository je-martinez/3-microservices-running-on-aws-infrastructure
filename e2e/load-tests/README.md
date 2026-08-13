# Load tests (Gatling JS + Chance.js)

Generates sustained, realistic traffic across every 3MRAI endpoint so the
dashboards have something to read. The E2E suite next door checks correctness
with a handful of requests; percentiles over four requests are noise.

## Prerequisites

**Node 24+ and pnpm — no JDK.** The Gatling CLI downloads its own runtime into
`~/.gatling/` on first run (~180MB, one time).

```bash
nvm use && pnpm install
```

## Running

Both variables come from files `make bootstrap` generates:

```bash
export API_GATEWAY_URL=$(grep -m1 API_GATEWAY_URL ../../.env.local.infra | cut -d= -f2-)
export TRACKING_CARRIER_API_KEY=$(grep -m1 TRACKING_CARRIER_API_KEY ../../.env.local.tracking | cut -d= -f2-)

pnpm run smoke   # ~30s, low rate — a sanity check
pnpm run load    # the default profile
pnpm run users   # the Users journey alone
```

Tune any profile without editing a file:

```bash
pnpm exec gatling run --typescript --simulation fullJourney \
  usersPerSec=5 duration=600 rampUsers=50 rampDuration=60
```

The HTML report path is printed at the end of each run.

## What it does

Three populations run together, because real traffic is not uniform:

- **Buyer** — register → login → read/update profile → browse products → order
  → read orders → **drive the delivery through the carrier webhook** → read
  tracking.
- **Browser** — signs up and looks around without ordering, at ~3× the buyer
  rate.
- **Error traffic** — deliberate 401s, a missing order, and a rejected status
  transition, so the error panels carry signal instead of sitting empty.

## Deliberately unlike the E2E suite

- **No `x-e2e-source`.** That tag exists so the E2E teardown can delete its own
  rows. This data is meant to persist like real data — which also means
  **nothing cleans it up**; reset with `make clean && make bootstrap`.
- **No `x-test-mode`.** Without it a tracking does not advance on its own, which
  is why the simulation calls the carrier webhook itself — the way a real
  carrier does.
- **Through the gateway**, never service ports, so traffic traverses the JWT
  authorizer and nginx.
- **A token per virtual user.** A shared one would collapse every user-scoped
  read onto a single `cognito_sub` and hide the per-user query cost.

## Two findings worth keeping

**`session.userId()`, not a module counter.** A module-level counter produced
the *same* email five times in one run: simulation modules are evaluated per
execution context in GraalVM, so module scope is not the single shared sequence
it looks like. One duplicate email cascades — registration 409s, the login then
fails, and every authenticated step after it 401s, so one data bug reads as a
broken auth chain.

**409 on order creation is expected under load.** Creating an order locks the
product row `FOR UPDATE`, so concurrent buyers genuinely contend and some lose
the race. `createOrder` accepts 201 *or* 409 and the steps that need an order id
are guarded, so one contention event does not cascade into five derived
failures. A rising 409 rate is a real signal — read it in `http_errors_total`.
