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

## The cache A/B

The same traffic profile, run twice — once with the response cache on, once with
it off — so the difference between the two reports *is* the cache's effect. It
cannot be one run: `CACHE_ENABLED` is read at process start, so flipping it
mid-run is impossible without a restart, and a restart inside a measurement
window poisons both halves with cold pools and an unwarmed JIT.

```bash
make load-test-cache-ab-on     # leg A — flips CACHE_ENABLED=true,  restarts, runs
make load-test-cache-ab-off    # leg B — flips CACHE_ENABLED=false, restarts, runs
make cache-toggle V=true       # ALWAYS run this afterwards (see below)
```

Both targets call `make cache-toggle`, which rewrites `CACHE_ENABLED` in the
**CUSTOM** box of `.env.local.{orders,tracking,users}` (preserved verbatim by
`make env-file`), recreates the three containers and waits for their health
checks. **Leaving the flag off is the trap to avoid:** every assertion in
`e2e/tests/cache.spec.ts` and `e2e/tests/gateway/cache.spec.ts` then fails with
*"no X-Cache header at all"*, which reads as a broken cache rather than a
forgotten toggle.

### Reading the result

Each cached endpoint appears as **two rows**, `(cold)` and `(warm)`, because
Gatling reports percentiles per request name. The `(warm)` row is the cached
read; the `(cold)` row is the database read. On the OFF leg the two rows should
**converge** — both are database reads — and that convergence is itself the
check that the A/B was really performed rather than the same leg run twice.

| Endpoint (row) | p50/p95 cache ON | p50/p95 cache OFF | Hit-rate |
|---|---|---|---|
| `GET /v1/users/me (cold)` | 11 / 20 ms | 9 / 76 ms | — |
| `GET /v1/users/me (warm)` | **6 / 36 ms** | 6 / 9 ms | ~100% |
| `GET /v1/products (warm)` | 10209 / 12041 ms | 12 / 29 ms | ~100% |
| `GET /v1/cart (warm)` | 9833 / 11242 ms | 15 / 22 ms | ~100% |
| `GET /v1/orders/my-orders (warm)` | 9383 / 12032 ms | 11 / 29 ms | ~100% |
| `GET /v1/orders/my-orders?includeTracking=true (warm)` | 8603 / 9655 ms | 25 / 110 ms | ~100% |
| `GET /v1/orders/{id} (warm)` | 7628 / 9315 ms | 12 / 19 ms | ~100% |
| `GET /v1/trackings/{orderId} (warm)` | 3680 / 4841 ms | 15 / 52 ms | ~0% at the time — see note |
| `GET /v1/trackings?order_ids= (warm)` | 3630 / 5479 ms | 14 / 18 ms | ~0% at the time — see note |

> [!warning] These numbers are NOT a valid A/B — read the caveat before quoting them
> Measured 2026-08-26 with a short smoke profile (`usersPerSec=0.5 duration=20
> rampUsers=3 rampDuration=5`, 273 requests per leg), on a machine whose load
> average was **6.5** from work unrelated to this stack. The ON leg is
> **slower than the OFF leg on every Orders row**, which the cache cannot cause.
>
> The cause was isolated and is not the cache: with the stack idle,
> `GET /v1/orders/products` returns `X-Cache: HIT` and still takes ~480ms
> *as measured by Orders itself*, while `GET /v1/health` on the same container
> answers in **1ms** and no DB command is issued at all. So the time is spent in
> Orders' authenticated middleware pipeline on a saturated host, and it swamps
> the microseconds the cache saves. **Users is the only service that was not
> stalling**, and it is the only row worth reading: `(warm)` p50 6ms against a
> `(cold)` p50 of 11ms.
>
> Re-run both legs on an idle machine with the full profile before quoting any
> figure here. The hit-rate column, unlike the latency columns, IS trustworthy:
> it comes from the `X-Cache` header rather than from timing.

### The identity cache is reported separately — never averaged in

`identity:sub-to-user:v1:{cognito_sub}` has a 1-hour TTL over an effectively
immutable mapping, so its hit-rate sits near **100%**. Averaging it into the
response-cache figures would drag every one of them toward 100% and make *both*
numbers meaningless, so it gets its own line and never a shared row:

> **Identity cache** (`identity:sub-to-user:v1`) — hit-rate ~100%, 1h TTL.

The simulation never sees it (it lives behind the response cache, so no
`X-Cache` header reflects it). Read it from the `cache_requests_total` metric in
OpenObserve instead, filtered per `KeyPrefix`, with `bypass` **excluded** from
the denominator:

```
hit / (hit + miss)   for KeyPrefix = 'identity:sub-to-user:v1'
```

and the response-cache prefixes one row each: `orders:products:v1`,
`orders:cart:v1`, `orders:my-orders:v1`, `orders:order:v1`, `tracking:order:v1`,
`tracking:list:v1`, `users:me:v1`.

### The Tracking rows in that table were measured against a since-fixed defect

The ~0% hit-rate above is **stale**. It was real when measured: an identity-cache
hit skipped the loader that populated `CurrentCaller._resolved`, so Tracking's
response key built as `None` and the handler stamped MISS without touching
Redis. That was fixed by `seed_resolved_internal_user_id()`, and both routes now
go MISS→HIT — verified live, and asserted by six specs in
`e2e/tests/cache.spec.ts`. Re-measure before quoting those two rows.

What survives the fix and is worth knowing, because it produces the SAME
symptom: Tracking's key embeds the internal `usr_` id resolved from the
`cognito_sub` over gRPC, and a caller Users cannot resolve gets no key at all —
by design — so it reads MISS forever. The simulation registers each virtual user
through the normal flow, which keeps them resolvable. A run that reused a seeded
or fixed sub would show 0% and look like a cache failure.
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
