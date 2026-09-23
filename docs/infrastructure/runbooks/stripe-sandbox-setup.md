---
title: "Stripe Sandbox and Key Setup"
type: runbook
area: infra
status: active
created: 2026-09-21
updated: 2026-09-22
integration-status: not-started
verified-on: null
verified-by: null
tags: [type/runbook, area/infra, status/active]
related:
  - "[[2026-09-19-stripe-payments-design]]"
  - "[[2026-09-19-stripe-payments]]"
  - "[[env-files]]"
  - "[[local-dev]]"
  - "[[secret-rotation]]"
  - "[[ADR-0009-apigw-alb-fargate]]"
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
---

# Stripe Sandbox and Key Setup

## When to run this

Run this before starting Task 1 of the Stripe Payments milestone
([[2026-09-19-stripe-payments-design]]). The spec's Decision 13/15/17 name which keys are
needed and what each may do; this runbook is the operator-facing "how" — the sandboxes and
keys are a hard prerequisite of `STRIPE_ENABLED=true` exercising anything past the "no key"
503 branch.

## 1. Create the sandboxes (Decision 17)

Two sandboxes are needed — **local development** and **CI** — and they never share state or
configuration. Anything configured inside one (keys, Tax Settings, anything else) does not
exist in the other; each must be set up independently.

1. Install the Stripe CLI as `@stripe/cli` — this repo uses pnpm, never npm:
   ```bash
   pnpm add -g @stripe/cli
   ```
2. Confirm CLI auth state:
   ```bash
   stripe whoami --format json
   ```
   Expected: JSON showing the logged-in account. If not authenticated, run `stripe login`
   first. Do **not** use `stripe config --list` for this check — it reports local config, not
   auth state.
3. Create the local-dev sandbox:
   ```bash
   stripe sandbox create
   ```
   Expected: a new sandbox with its own test API keys, no registration required.
4. Repeat for CI — create a **second, separate** sandbox the same way. Keep the two sandboxes'
   keys apart from the start; they go to different destinations (step 4 and step 6 below).

> [!warning] `stripe sandbox create` vs. the Stripe MCP
> If a sandbox is created with `stripe sandbox create`, do not also use the Stripe MCP against
> it. If the MCP is wanted later for this sandbox, run `stripe sandbox claim` on it first.

## 2. Create one restricted key per service (Decision 15)

Dashboard → **Developers → API keys → Create restricted key**. Do this **once per sandbox**
(local-dev sandbox now; repeat in the CI sandbox in step 6).

Stripe's restricted-key editor groups **Charges and Refunds as a single resource** with one
permission level (None / Read / Write) — there is no separate Charges row and Refunds row, and
Write includes Read.

| Resource | Users' key | Orders' key |
|---|---|---|
| Customers | Write | None |
| PaymentMethods | Write | None |
| SetupIntents | Write | None |
| PaymentIntents | None | Write |
| Charges and Refunds | None | Write |
| Everything else | None | None |

Users' key creates customers, attaches/detaches cards, and sets the default payment method.
Orders' key charges and refunds — it must **not** reach Customers or PaymentMethods, so a
compromised Orders key cannot touch a saved card.

> [!note] Orders' key has no PaymentMethods access at all — by design
> Orders charges an existing `payment_method` id and never looks one up. The payment
> snapshot's card brand/last4/expiry come from the **charge** (`latest_charge.payment_method_details.card`
> on the PaymentIntent, expanded at creation time), never from a PaymentMethods read. Charges
> and Refunds is set to **Write** (which includes Read) because a refund is a write, the
> idempotency replay guard (design spec Decision 7) lists a PaymentIntent's refunds to detect a
> prior refund on a replayed request, and the `latest_charge` expansion itself is a Charges read.
> See [[2026-09-19-stripe-payments-design]] Decision D (user, 2026-09-22).

> [!warning] Write on Charges and Refunds technically permits the legacy Charges API
> Stripe grants Charges and Refunds together, so Orders' key technically has enough permission
> to call the legacy Charges API even though this integration never does. The ban on the
> Charges API (Global Constraints / Decision 16) is enforced by code review and the
> prohibited-API grep, not by the key's permission scope.

> [!warning] The key is shown once
> Stripe shows a restricted key's value only at creation time. It cannot be retrieved
> afterward — only rolled. Copy it into the destination file (section 4) immediately.

Then configure a **separate access policy per key** — Dashboard → API keys → configure access
policy for each key. Users' and Orders' policies must differ from each other (permissions
control *what* a key can call; the access policy controls *who/where* can use it — compromising
one service's environment must not expose the other's).

## 3. Get the webhook signing secret (Decision 10, Decision 26)

**Both** Users and Orders now receive webhooks (Decision 26, user, 2026-09-22 — Orders'
webhook handles payment *reconciliation*: orphan charges, refunds made outside the app, and
disputes; Users' webhook keeps reconciling saved-card state, unchanged). `stripe listen` mints
**one** signing secret per running process, valid for every event it forwards on this machine
— so both services get the **same** `whsec_...` value; this is one secret written to two
files, not two separate secrets.

```bash
stripe listen --forward-to http://localhost:3000/v1/users/stripe/webhook
```

Expected: on startup, the CLI prints a line containing `whsec_...`. Copy that value.

> [!danger] The dashboard's webhook secret is NOT this secret
> `stripe listen` mints its **own** signing secret, different from any secret shown on the
> Dashboard's webhook-endpoints page. Using the dashboard's value locally fails signature
> verification with an HTTP 400 that reads exactly like a bug in the webhook handler. This is
> the single most likely way to lose an hour on this setup — if signature verification is
> failing locally, check this first before reading any code.

In this repo, the CLI runs as the `stripe-cli` compose service behind `profiles: [stripe]`:

```bash
make stripe-up
make stripe-logs
```

Read the `whsec_...` value from that container's startup log via `make stripe-logs`.

> [!warning] Forwarding to two destinations is not yet resolved as of this runbook's last update
> Whether one `stripe listen` invocation can forward to both
> `users:3000/v1/users/stripe/webhook` and `orders:8080/v1/orders/stripe/webhook`, or whether
> two concurrent processes are needed (which would mint **two different** secrets, contradicting
> the shared-secret premise above), is verified — not guessed — in
> [[2026-09-19-stripe-payments]] Task 10c.9, by running `stripe listen --help` against the
> installed CLI. Read that task's outcome before assuming the exact compose command shape.
> `make stripe-webhook-secret` writes the one secret it obtains into **both**
> `.env.local.users` and `.env.local.orders` regardless of which shape wins (Task 10c.8).

## 3b. URL tokens and the IP allowlist (Decision 27)

Two more layers sit in front of signature verification on both webhooks, enforced in the
services themselves, not in nginx or at the gateway edge — see
[[2026-09-19-stripe-payments-design]] Decision 27 for the reasoning. Order of checks: IP
allowlist → URL token → signature.

**URL token.** Each service's webhook route carries a trailing `/{token}` segment —
`POST /v1/users/stripe/webhook/{token}` and `POST /v1/orders/stripe/webhook/{token}` — and each
service has its **own** `STRIPE_WEBHOOK_URL_TOKEN` (≥ 32 random URL-safe bytes), distinct per
service. `make stripe-webhook-secret` also mints each service's token into its CUSTOM box when
absent (Task 10d.7) — it preserves an existing token rather than rotating it silently, and
prints the two `stripe listen --forward-to` commands with the tokens masked unless explicitly
asked to reveal them. The token is a secret exactly like the restricted keys in section 2: never
log it, never put it on a span, never commit it — only the route **template**
(`…/webhook/{token}`) belongs in an access log or trace attribute, never the concrete value.

Once Task 10d lands, the `stripe listen --forward-to` commands from section 3 gain the token
segment:

```bash
stripe listen --forward-to http://localhost:3000/v1/users/stripe/webhook/<users token>
stripe listen --forward-to http://localhost:3001/v1/orders/stripe/webhook/<orders token>
```

(or the single-invocation form, if Task 10c.9 confirmed one `stripe listen` process can forward
to both destinations — see the warning in section 3 above).

**IP allowlist.** `STRIPE_WEBHOOK_ALLOWED_CIDRS` (comma-separated IPs/CIDRs) and
`STRIPE_WEBHOOK_TRUSTED_PROXY_HOPS` are written into both services' **AUTO** box by
`make env-file` (Task 10d.6) — unlike the restricted keys and the URL token, these are not
hand-injected secrets. Locally, the allowlist is Stripe's published webhook IPs **plus**
loopback and private ranges (`127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`,
`192.168.0.0/16`), because `stripe listen` forwards from the developer's own machine straight to
the service port; local trusted hops = `0`.

> [!warning] Production trusted-hop count is an open item
> The production value for `STRIPE_WEBHOOK_TRUSTED_PROXY_HOPS` (API Gateway HTTP API → ALB →
> Fargate) must be verified at deployment time, not guessed — see Decision 27. Do not carry the
> local value of `0` into a real deployment without checking it.

> [!warning] Refresh the production IP list from Stripe's published source
> Stripe's webhook source IPs (docs.stripe.com/ips, downloadable as `ips_webhooks.json`) can
> change. The list recorded in Decision 27 is current as of 2026-09-22 — re-fetch it before a
> real deployment rather than treating it as a permanent constant.

## 4. Where each value goes

Every value below goes in the **CUSTOM box**, never the AUTO box — `make env-file` rewrites
the AUTO box from Terraform outputs on every run ([[env-files]]). `make env-file` seeds
`STRIPE_ENABLED=false`, `STRIPE_SECRET_KEY=` and `STRIPE_WEBHOOK_SECRET=` into
`.env.local.users`'s CUSTOM box when they are absent, and `STRIPE_ENABLED=false` /
`STRIPE_SECRET_KEY=` / `STRIPE_WEBHOOK_SECRET=` (the last one added by
[[2026-09-19-stripe-payments]] Task 10c.7, once Orders has a webhook to receive — Decision 26)
into `.env.local.orders`'s CUSTOM box, so you fill them in place (empty = unset).

| Value | File | Box |
|---|---|---|
| `STRIPE_ENABLED=true` | `.env.local.users` AND `.env.local.orders` | CUSTOM |
| `STRIPE_SECRET_KEY=rk_test_...` (Users' restricted key) | `.env.local.users` | CUSTOM |
| `STRIPE_SECRET_KEY=rk_test_...` (Orders' restricted key — a **different** key, narrower permissions — see section 2's note) | `.env.local.orders` | CUSTOM |
| `STRIPE_WEBHOOK_SECRET=whsec_...` (from `stripe listen` — the **same** value in both files, per section 3) | `.env.local.users` AND `.env.local.orders` | CUSTOM |
| `STRIPE_WEBHOOK_URL_TOKEN=<random>` (Users' own token — see section 3b) | `.env.local.users` | CUSTOM |
| `STRIPE_WEBHOOK_URL_TOKEN=<random>` (Orders' own, **different** token — see section 3b) | `.env.local.orders` | CUSTOM |
| `NG_APP_STRIPE_PUBLISHABLE_KEY=pk_test_...` | `apps/web/.env` (until Task 11 lands, below) | — (public, see below) |
| `NG_APP_STRIPE_ENABLED=true` | `apps/web/.env`, and `docker-compose.yml`'s web build arg (currently hardcoded `"false"`, until Task 11 lands, below) | — |

`STRIPE_WEBHOOK_ALLOWED_CIDRS` and `STRIPE_WEBHOOK_TRUSTED_PROXY_HOPS` are **not** in this
table — they are AUTO-box values written by `make env-file` (section 3b), not hand-injected.

> [!note] After [[2026-09-19-stripe-payments]] Task 11 lands
> Both rows above move: `NG_APP_STRIPE_ENABLED` and `NG_APP_STRIPE_PUBLISHABLE_KEY` (plus every
> other `NG_APP_*` the web Dockerfile declares) come from the root `.env`'s CUSTOM box, seeded
> per-key by `make env-file` — not from a hand-maintained `apps/web/.env` or a hardcoded compose
> literal. See [[env-files]]'s "Web `NG_APP_*` build args" section. Until that task lands, the
> instructions above are still the correct, current procedure.

The publishable key is on the same Dashboard API keys page as the restricted keys. It is
**public** — it ships inside the compiled web bundle and is readable by anyone in devtools —
and is the only Stripe value allowed in `apps/web/.env`; neither restricted key nor the webhook
secret ever belongs there. It is safe to commit a placeholder value to `.env.example`, never a
real one.

## 5. Verify the setup

| Check | Command / action | Expected result |
|---|---|---|
| CLI is authenticated against the sandbox | `stripe whoami --format json` | Shows the sandbox account |
| Key present, flag on | Set `STRIPE_ENABLED=true` and a real key, boot Users | Users boots; payment-method routes respond normally (not 503) |
| Key absent, flag on (Decision 13) | Set `STRIPE_ENABLED=true`, leave `STRIPE_SECRET_KEY` unset, boot Users | Users still boots, logs a warning, Stripe routes answer 503 — verify this deliberately, it is what protects the local environment from a missing secret |
| Flag off (default) | Leave `STRIPE_ENABLED=false` | Nothing Stripe-related is mounted; repo behaves exactly as before |
| Orders' webhook secret present, flag on (Decision 26) | Set `STRIPE_ENABLED=true` and a real `STRIPE_WEBHOOK_SECRET` on Orders, boot Orders | `POST /v1/orders/stripe/webhook/{token}` verifies a correctly-signed test event and answers 2xx |
| Orders' webhook secret absent, flag on | Set `STRIPE_ENABLED=true`, leave Orders' `STRIPE_WEBHOOK_SECRET` unset | Orders still boots; the webhook route answers 503, the same graceful-degradation shape as every other Stripe-backed route (Decision 13) |
| Wrong or missing URL token (Decision 27) | POST to the webhook route with the wrong `{token}`, or no token segment at all | `404`, indistinguishable from an unmapped route |
| URL token unset, flag on (Decision 27) | Set `STRIPE_ENABLED=true`, leave `STRIPE_WEBHOOK_URL_TOKEN` unset | `503 stripe_unavailable`, same shape as a missing `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` |
| Disallowed source IP (Decision 27) | POST with the correct token and signature from an address outside `STRIPE_WEBHOOK_ALLOWED_CIDRS` | `403 forbidden_source`, logged at WARNING with `reason=source_ip_not_allowed` |

## 6. CI

The CI sandbox (created in section 1) gets its **own** pair of restricted keys, its **own**
webhook signing secret(s) for both services' webhooks (Users' and, per Decision 26, Orders'),
and its **own** pair of `STRIPE_WEBHOOK_URL_TOKEN` values (Decision 27) — created the same way
as sections 2, 3, and 3b but stored as CI secrets — never in any `.env.local.*` file. Per
Decision 17's scoping caveat, the CI sandbox does not inherit anything configured in the
local-dev sandbox (or vice versa); repeat sections 2, 3, and 3b independently against the CI
sandbox rather than assuming carryover. In a real deployment (unlike local `stripe listen`),
Users' and Orders' webhook endpoints each get their own Dashboard-issued secret rather than
sharing one — the shared-secret shape in section 3 is a `stripe listen` characteristic, not a
rule that carries to CI or production.

## 7. Rotation and incident response

For general credential rotation mechanics, see [[secret-rotation]]. The Stripe-specific
procedure, restated from Decision 15 so it exists before it is needed:

1. **Roll or delete the exposed key immediately** from the Dashboard's API keys page — even
   before confirming it was actually used by an unauthorized party.
2. **Review Workbench request logs** for that key for unrecognized activity.
3. **Contact Stripe support** if anything in those logs is unrecognized.

Practice rolling a key ahead of any incident so the procedure is not learned live. The same
"roll immediately, do not wait to confirm misuse" rule applies to a leaked
`STRIPE_WEBHOOK_URL_TOKEN` — it is a secret with the same blast radius as a restricted key for
this endpoint, since it gates the endpoint's reachability before signature verification even
runs.

**For a real deployment**, two things this runbook's local-only sections do not cover:
- The Dashboard-configured webhook endpoint URL must **include the production token** — the
  Dashboard's webhook-endpoints page takes a full URL, and the token segment is part of it
  (`https://.../v1/orders/stripe/webhook/<production token>`), not appended separately anywhere
  else.
- The IP allowlist (`STRIPE_WEBHOOK_ALLOWED_CIDRS`) must be **kept in sync with Stripe's
  published list** (docs.stripe.com/ips) — it is not a one-time copy at deployment time. See
  Decision 27's warning in section 3b.

## Related

- [[2026-09-19-stripe-payments-design]] — Decisions 10, 13, 15, 17, 26, 27, and D, which this
  runbook operationalizes.
- [[2026-09-19-stripe-payments]] — Task 11 step 11.4b, which moves the two web `NG_APP_*`
  rows in section 4 from a hand-maintained `apps/web/.env`/hardcoded compose literal to the
  root `.env`'s CUSTOM box; Task 10c, which adds Orders' webhook (section 3's two-destination
  question, section 4's Orders webhook-secret row); Task 10d, which adds the URL token and IP
  allowlist this runbook's section 3b/section 5's new checks operationalize.
- [[env-files]] — the AUTO/CUSTOM box convention governing where every value in section 4 lives,
  and which distinguishes the AUTO-box `STRIPE_WEBHOOK_ALLOWED_CIDRS`/
  `STRIPE_WEBHOOK_TRUSTED_PROXY_HOPS` (section 3b) from the CUSTOM-box secrets in section 4.
- [[local-dev]] — the `profiles:`-gated optional-service pattern `stripe-cli` follows.
- [[secret-rotation]] — general credential rotation mechanics referenced from section 7.
- [[ADR-0009-apigw-alb-fargate]] — the production API Gateway → ALB → Fargate shape whose
  trusted-hop count section 3b flags as an open item to verify at deployment time.
- [[ADR-0016-local-apigw-nginx-ecs]] — the local API Gateway/nginx emulation this runbook's
  local-only sections (1–6) operate against, as distinct from the real-deployment notes in
  section 7.
