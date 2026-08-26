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

pnpm run smoke       # ~30s, low rate — a sanity check
pnpm run load        # the default profile
pnpm run users       # the Users journey alone
pnpm run auth-codes  # OTP login + password reset (needs MAILPIT_API_URL)
pnpm run delete-account  # account deletion + its synchronous cascade
```

The email-code flows also need Mailpit:

```bash
export MAILPIT_API_URL=$(grep -m1 MAILPIT_API_URL ../../.env.local.infra | cut -d= -f2-)
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

## Account deletion lives in its own simulation

`accountDeletion` covers `DELETE /v1/users/me` — register → order → delete —
alongside a control population of ordinary browsers.

**It is not a throughput test, and should not be read as one.** Account deletion
is low-frequency, destructive and terminal: nobody deletes their account twice,
so a sustained deletion rate is not a traffic pattern that occurs. What it
measures is the **cascade's cost under concurrency**. `DELETE /v1/users/me` is the
only user-facing request in 3MRAI that synchronously fans out to two other
services *and* an external identity provider before answering — Orders' MySQL
sweep, Tracking's MySQL sweep, its own Postgres soft-delete, then Cognito
`AdminDeleteUser`. Its latency is the **sum** of four dependencies, so the tail
compounds in a way no single-service endpoint's does.

That shows up immediately. Measured at 1 user/sec over 45s (710 requests, 0
failures):

| Request | p95 |
|---|---|
| `DELETE /v1/users/me` (four-leg cascade) | **153 ms** |
| `GET /v1/products` (single service, read) | 50 ms |
| `GET /v1/users/me (after deletion)` | 5 ms |

The **bystander scenario is the point of the design**, not filler: it runs
ordinary browsing concurrently with the deletions, so the run can answer "do the
cascade's write transactions degrade everyone else's reads?" — a question a
simulation containing only deletions cannot ask. `GET /v1/products` staying flat
is the control assertion.

The injection profile is deliberately modest (defaults to 1 user/sec). Every
virtual user here is **single-use and destructive**: it registers, buys and then
permanently removes itself, so there is no steady state to reach — raising the
rate burns accounts faster rather than finding a new regime. It also costs a
Cognito create *and* delete per user on the Floci emulator, which past some rate
becomes the bottleneck itself, at which point the run measures Floci.

## The email-code flows live in their own simulation

`authCodes` covers passwordless OTP login and password reset end to end — it
reads the six-digit code out of Mailpit's HTTP API, the way a person reads their
inbox.

It is separate from `fullJourney` because every virtual user there waits for an
email to travel service → SQS → Lambda → SES → Mailpit, which takes seconds.
Mixed into the main run those seconds would inflate its percentiles with latency
that is not ours. Here they are isolated, and the polling request is named
`GET mailpit (wait for code)` so it occupies its own row in the report.

That separation is what keeps the numbers honest: in a verified run,
`otp/start` answered in **26ms** and `password/forgot` in **15ms** while the
inbox wait ran into seconds. Assertions cover our endpoints only — holding the
Mailpit wait to a latency budget would fail the run for something this
simulation does not measure.

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

## Three findings worth keeping

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

**A body-less DELETE must not carry `Content-Type: application/json`.** Adding
`accountDeletion` cost two full 100%-failure runs before this was understood.
The other simulations set `.contentTypeHeader("application/json")` on the shared
protocol, which stamps it onto **every** request including body-less ones. Users
runs Fastify, and its content-type parser rejects that combination outright:

    400 FST_ERR_CTP_EMPTY_JSON_BODY
    "Body cannot be empty when content-type is set to 'application/json'"

The obvious repair does **not** work, and is worth recording so nobody retries
it: overriding the header per-request with `""` makes Gatling send a *literal
empty* `Content-Type`, and the 400 becomes a **415 Unsupported Media Type**. The
SDK has no per-request header removal. The fix is to leave `contentTypeHeader`
off the protocol entirely — which costs nothing, because every body-carrying
step already calls `.asJson()` and sets the header on its own request.

Note this is **not** a general rule about DELETEs, and assuming it was would be
the wrong lesson: Orders (.NET Minimal APIs) answers `204` to the identical
header-without-body request, which is why `cart.ts`'s `deleteCart` has run for
months without tripping on it. The strictness is Fastify's, so it applies to
body-less writes on **Users** specifically.
