---
title: "A WebSocket can die without telling you"
type: lesson
area: shared
status: active
created: 2026-10-02
updated: 2026-10-02
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/high
related:
  - "[[live-session-indicator]]"
  - "[[2026-09-10-in-app-notifications-design]]"
  - "[[2026-08-05-realtime-tracking-events-websocket-design]]"
  - "[[browser-rum]]"
  - "[[count-only-assertions-hide-cause]]"
  - "[[2026-09-15-a-falsy-default-that-means-disabled-erases-the-difference-from-unconfigured]]"
---

# A WebSocket can die without telling you

## Finding

The live-session indicator (PR #90) reports whether the notifications socket is alive. Two
distinct failure modes were **measured in a real browser** while building it, and each produced a
UI that confidently reported a live connection over a dead one. Neither is visible if the code
assumes the transport emits `close` whenever it fails.

### 1. A socket refused by CSP is born closed and never fires `close`

When Content-Security-Policy refuses the connection, the `WebSocket` is constructed already
`CLOSED` (`readyState === 3`).

- The constructor does **not** throw.
- It fires `error`, and it **never** fires `close`.
- `socket.close()` on it is a no-op.

Code that arms its retry only from `onclose` therefore leaves this socket dead with no retry
scheduled, and the UI reads "Connecting…" for the rest of the session.

### 2. Losing the network does not close an established socket

Measured with DevTools set to offline: `readyState` stays `1` (OPEN) for at least 8 seconds,
`navigator.onLine` flips to `false`, and **neither `close` nor `error` fires**. The socket is a
zombie — open to the browser, dead in practice. A state derived from `readyState` keeps saying
"live".

### 3. A flag keyed on "has it ever opened?" cannot tell a first attempt from a failing retry

A handshake that never completes leaves an `everOpened` flag `false` forever, so a failing retry
looks identical to the first attempt and the UI shows an eternal "Connecting…". This shipped first.
**Count attempts instead**: zero attempts is "connecting"; one or more without an open socket is a
failure being retried.

## The fix that shipped

All in `apps/web/src/app/core/notifications/notifications-socket.ts`:

- **`error` arms the retry itself.** Idempotent through a `this.socket !== socket` guard, so a
  normal drop that fires both `error` and `close` still schedules exactly one redial.
- **The browser's own `offline` / `online` events** drop and redial the socket. The browser knows
  before the socket does.
- **A 70-second silence watchdog** covers drops the browser never reports. Any frame restarts it.
- **State counts attempts**, not "has it ever opened".

## Why there is no heartbeat

A client ping is not available on this channel. `functions/realtime-events/src/default.ts`
answers any inbound frame with HTTP 400 and logs `ws_unexpected_inbound_message`, because the
channel is server-to-client only — a heartbeat would file a warning per beat. The only evidence
available is the **absence of traffic**, which is why the watchdog is a silence timer and not a
pong deadline. See [[2026-08-05-realtime-tracking-events-websocket-design]].

## Cost and process

This cost most of a session, and **three diagnoses were wrong before anything was measured**.
Each was a plausible argument from how WebSockets are documented to behave. The behaviour was
only settled by constructing the socket under the real CSP and toggling DevTools offline, then
printing `readyState`, `navigator.onLine` and which events fired. The same discipline as
[[count-only-assertions-hide-cause]]: observe what actually arrived instead of reasoning about
what must have.

## Rule

A live-connection indicator derives its state from evidence the transport actually provides and
never assumes `close` fires on failure. See [[live-session-indicator]].

## Related

- [[live-session-indicator]] — the convention this lesson produced.
- [[2026-09-10-in-app-notifications-design]] — the design whose socket carries the fix.
- [[2026-08-05-realtime-tracking-events-websocket-design]] — the server-to-client-only channel that rules out a ping.
- [[browser-rum]] — sibling browser-side silent-failure rules.
- [[count-only-assertions-hide-cause]] — measure what arrived, do not infer it.
- [[2026-09-15-a-falsy-default-that-means-disabled-erases-the-difference-from-unconfigured]] — another UI state that read as healthy while the surface was dead.
