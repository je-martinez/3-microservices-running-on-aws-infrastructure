---
title: "Live Session Indicator — Evidence and UI Split"
type: convention
area: shared
status: active
created: 2026-10-02
updated: 2026-10-02
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[2026-10-02-a-websocket-can-die-without-telling-you]]"
  - "[[2026-09-10-in-app-notifications-design]]"
  - "[[browser-rum]]"
  - "[[pencil-design-extraction]]"
  - "[[angular-component-authoring]]"
---

# Live Session Indicator — Evidence and UI Split

Web-app documentation has no service folder, so this convention covers the header indicator that
shows whether the notifications socket is alive (PR #90). It carries two rules.

## Rule 1 — State comes from evidence the transport provides

A live-connection indicator derives its state from signals the transport actually emits. It must
**not** assume `close` fires on failure: a CSP-refused socket is born closed and never fires it,
and a lost network leaves an established socket OPEN with no event. Evidence, in order of speed:

1. The browser's `offline` / `online` events.
2. `error` and `close` — either one drops the socket, idempotently.
3. **Absence of traffic** past a watchdog (70 s). Where the channel is server-to-client only, no
   ping exists, so silence is the only evidence.
4. An **attempt count**, never an "ever opened" flag, to separate a first attempt from a failing
   retry.

The state exposed to the UI is four-valued — `connecting`, `live`, `reconnecting`, `offline` —
because the transport's `closed` covers two opposite situations (a retry is armed, or nothing is
coming). Reasoning and measurements: [[2026-10-02-a-websocket-can-die-without-telling-you]].

## Rule 2 — The header indicator is silent; the words live in the menu

- **Badge** (`live-session-badge`, concept N of `.pen` frame `pacf4`): wraps the header's
  account-menu button. It is deliberately **silent** — no text, no hover, no click — because the
  button underneath owns the click.
- **Chip** (`live-session-chip`, option E of `.pen` frame `QgShq`): sits inside the account menu's
  identity block, above the first divider so Profile stays the first action. It carries the state's
  words and the `Retry` action, shown on `offline` alone, and explains itself on hover and focus.

Do not add text, a tooltip, or a click handler to the badge. Both components consume the same
`liveState` signal and emit nothing of their own. Token and component notes live in
`apps/web/DESIGN.md`; the single new token is `warn-amber` ([[pencil-design-extraction]]).

## Related

- [[2026-10-02-a-websocket-can-die-without-telling-you]] — the measured failures behind Rule 1.
- [[2026-09-10-in-app-notifications-design]] — the design that owns the socket and its `liveState`.
- [[browser-rum]] — sibling rule: new web surfaces must not fail silently.
- [[pencil-design-extraction]] — how the `.pen` frames became code.
- [[angular-component-authoring]] — component conventions the badge and chip follow.
