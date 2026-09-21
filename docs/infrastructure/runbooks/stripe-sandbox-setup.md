---
title: "Stripe Sandbox and Key Setup"
type: runbook
area: infra
status: active
created: 2026-09-21
updated: 2026-09-21
integration-status: not-started
verified-on: null
verified-by: null
tags: [type/runbook, area/infra, status/active]
related:
  - "[[2026-09-19-stripe-payments-design]]"
  - "[[env-files]]"
  - "[[local-dev]]"
  - "[[secret-rotation]]"
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

| Resource | Users' key | Orders' key |
|---|---|---|
| Customers | Write | None |
| PaymentMethods | Write | None |
| SetupIntents | Write | None |
| PaymentIntents | None | Write |
| Refunds | None | Write |
| Everything else | None | None |

Users' key creates customers, attaches/detaches cards, and sets the default payment method.
Orders' key charges and refunds — it must **not** reach Customers or PaymentMethods, so a
compromised Orders key cannot touch a saved card.

> [!warning] The key is shown once
> Stripe shows a restricted key's value only at creation time. It cannot be retrieved
> afterward — only rolled. Copy it into the destination file (section 4) immediately.

Then configure a **separate access policy per key** — Dashboard → API keys → configure access
policy for each key. Users' and Orders' policies must differ from each other (permissions
control *what* a key can call; the access policy controls *who/where* can use it — compromising
one service's environment must not expose the other's).

## 3. Get the webhook signing secret (Decision 10)

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

## 4. Where each value goes

Every value below goes in the **CUSTOM box**, never the AUTO box — `make env-file` rewrites
the AUTO box from Terraform outputs on every run ([[env-files]]).

| Value | File | Box |
|---|---|---|
| `STRIPE_ENABLED=true` | `.env.local.users` AND `.env.local.orders` | CUSTOM |
| `STRIPE_SECRET_KEY=rk_test_...` (Users' restricted key) | `.env.local.users` | CUSTOM |
| `STRIPE_SECRET_KEY=rk_test_...` (Orders' restricted key — a **different** key) | `.env.local.orders` | CUSTOM |
| `STRIPE_WEBHOOK_SECRET=whsec_...` (from `stripe listen`) | `.env.local.users` | CUSTOM |
| `NG_APP_STRIPE_PUBLISHABLE_KEY=pk_test_...` | `apps/web/.env` | — (public, see below) |
| `NG_APP_STRIPE_ENABLED=true` | `apps/web/.env`, and `docker-compose.yml`'s web build arg (currently hardcoded `"false"`) | — |

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

## 6. CI

The CI sandbox (created in section 1) gets its **own** pair of restricted keys, created the
same way as section 2 but stored as CI secrets — never in any `.env.local.*` file. Per
Decision 17's scoping caveat, the CI sandbox does not inherit anything configured in the
local-dev sandbox (or vice versa); repeat sections 2 and 3 independently against the CI
sandbox rather than assuming carryover.

## 7. Rotation and incident response

For general credential rotation mechanics, see [[secret-rotation]]. The Stripe-specific
procedure, restated from Decision 15 so it exists before it is needed:

1. **Roll or delete the exposed key immediately** from the Dashboard's API keys page — even
   before confirming it was actually used by an unauthorized party.
2. **Review Workbench request logs** for that key for unrecognized activity.
3. **Contact Stripe support** if anything in those logs is unrecognized.

Practice rolling a key ahead of any incident so the procedure is not learned live.

## Related

- [[2026-09-19-stripe-payments-design]] — Decisions 10, 13, 15, and 17, which this runbook
  operationalizes.
- [[env-files]] — the AUTO/CUSTOM box convention governing where every value in section 4 lives.
- [[local-dev]] — the `profiles:`-gated optional-service pattern `stripe-cli` follows.
- [[secret-rotation]] — general credential rotation mechanics referenced from section 7.
