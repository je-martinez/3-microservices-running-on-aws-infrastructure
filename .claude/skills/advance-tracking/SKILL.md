---
name: advance-tracking
description: Use when asked to move an order's delivery status locally — "advance order X to SHIPPED", "mark 260915C6119V delivered", "walk this order through every status", "trigger a notification for order Y". Drives the real carrier webhook through the gateway, so the whole chain fires: tracking event → SNS → notification row → WebSocket toast.
metadata:
  area: tracking
  script: infra/scripts/advance_tracking.py
  verified: 2026-09-15
---

# Advance a tracking's delivery status

Runs `infra/scripts/advance_tracking.py`, which calls the carrier webhook exactly
as a real carrier would: `PUT /v1/trackings/{order_id}/status` through the
gateway, authenticated with `TRACKING_CARRIER_API_KEY` and no JWT.

This is the real path, not a shortcut into the database — so every downstream
effect fires: the `TRACKING_STATUS_CHANGED` event, the pipeline's email, the
notification row in Users, and the live toast in the browser.

## Running it

Always the repo venv by absolute path, from the repo root:

```bash
.venv/bin/python infra/scripts/advance_tracking.py <order> <mode>
```

`<order>` is an order id (`ord_…`) or a 12-character order number
(`260915C6119V`) — the script detects which. Pass `--order-id` or
`--order-number` to be explicit.

One of three modes is required:

| Mode | What it does |
|---|---|
| `--next` | Advance exactly one step |
| `--status <NAME>` | Request that status — forward jumps are legal |
| `--all` | Every remaining step through `DELIVERED` |

Useful flags: `--dry-run` prints the requests without sending them; `--delay N`
changes the pause between `--all` steps; `--env FILE` reads config elsewhere.

## Choosing a mode

- "advance it" / "move it to the next status" → `--next`
- "mark it shipped" / a named status → `--status SHIPPED`
- "walk it through" / "take it to delivered" / "I want to see the toasts" → `--all`

**Show the user the transition line the script prints** (`PLACED → PROCESSING`),
not a paraphrase — it is the evidence the call landed.

## Before you run it

Prefer `--dry-run` first when the user named an order you have not verified: it
resolves the order and prints the plan without changing anything, which turns a
wrong id into a message instead of a wrong order advanced.

## Reading a failure

- `no live tracking with order_number '…'` — it does not exist, **or it was
  soft-deleted by an e2e cleanup run**. Most rows in a local tracking database
  are soft-deleted; only a handful are live. This is not a broken script.
- `HTTP 400 … reason: already_delivered` — the server rejected the transition.
  Statuses only move forward, and `DELIVERED` is terminal.
- `cannot tell what '…' is` — the argument is neither an `ord_` id nor 12
  characters. Ask which one the user meant.

## Watching the result

The default `--delay` is 8 seconds, chosen so each toast (7s) is seen whole
before the next arrives. Below 5 seconds the emulator starts dropping events and
the cascade arrives incomplete — the script warns rather than refusing, so it
stays usable when nobody is watching the screen.

For the toast to appear at all the web app needs `NG_APP_WS_URL` set; a missing
one disables the socket silently. See [[web-app-env-config]].

## Related

- [[tracking-service-design]] — the status machine and the carrier surface.
- [[2026-09-10-in-app-notifications-design]] — what a transition produces
  downstream: the notification row, the socket push, the toast.
- [[web-app-env-config]] — why the toast may not appear even when the status changed.
- [[two-api-keys-two-trust-domains]] — why the carrier key is not the gRPC key.
