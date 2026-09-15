---
title: "A falsy default that means \"disabled\" erases the difference from \"unconfigured\""
type: lesson
area: shared
status: active
created: 2026-09-15
updated: 2026-09-15
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/high
related:
  - "[[2026-09-10-in-app-notifications-design]]"
  - "[[env-files]]"
  - "[[testing]]"
  - "[[2026-09-04-a-build-time-env-var-absent-at-build-time-is-a-live-lookup]]"
  - "[[code-comments]]"
---

# A falsy default that means "disabled" erases the difference from "unconfigured"

## What happened

The web app's realtime notifications — live toasts, the live unread badge — never worked on a
developer machine for the entire length of the in-app-notifications milestone, and nobody
noticed. `apps/web/src/app/core/config/app-config.ts` read
`wsUrl: import.meta.env.NG_APP_WS_URL || ""`, and `NotificationsSocket.open()` began with
`const url = APP_CONFIG.wsUrl; if (!url) return;`. A missing variable and a deliberate opt-out
both collapse to the same empty string, so the socket was simply never opened. Nothing was
logged. The app rendered, routed, and looked entirely healthy — the whole realtime surface was
just quietly absent.

## Why it survived so long

`apps/web/.env` is gitignored and hand-maintained against `.env.example`, which ships
`NG_APP_WS_URL=` empty. `make env-file` generates the real value into `.env.local.web` as
`WS_URL=…`, but nothing bridges the two files and nothing warns when they diverge — see
[[env-files]]. The plan itself carried a verification step, "confirm toasts in the browser"
(`docs/superpowers/plans/2026-09-10-in-app-notifications.md`, Task 4.6 step "Verify it in the
browser"), that could not have passed against this configuration, and it was the one step
nobody had actually executed. Unit tests could not have caught it either: the code was
behaving exactly as written, against whatever value the test environment injected. What
finally caught it was a browser E2E exercising the toast for real and finding no WebSocket in
devtools other than Vite's HMR connection.

## The rule

**A falsy-coalescing default (`|| ""`, `?? false`) that turns "unconfigured" into "disabled"
erases the distinction between a deliberate choice and a mistake.** Where a feature can
legitimately be off, the off-state must be *observable*: warn, naming the variable and what is
lost, so absence is never silent. This generalizes past this one variable — any config value
whose "empty" reading is also a valid feature-off state needs its own signal that the empty
reading was reached, or a developer has no way to tell "I turned this off" from "I forgot to
set this."

## The fix, and why it does not throw

The fix (shipped 2026-09-15, `apps/web/src/app/core/config/app-config.ts`) moved the parse
behind an exported pure `parseAppConfig(env, warn)` that emits `console.warn` naming
`NG_APP_WS_URL`, stating that realtime is disabled, and pointing at `apps/web/.env` /
`.env.local.web` (`MISSING_WS_URL_WARNING`). It deliberately does **not** throw on a missing
value, for a reason worth recording because it is not obvious: `APP_CONFIG` is a module-level
`const` evaluated when the module is first imported — during bootstrap, **before**
`bootstrapApplication` runs. A throw at that point is not caught by `main.ts`'s `.catch`, and
that catch is exactly what dismisses the navy boot loader. Throwing there would trade a silent
missing feature for a permanently-stuck loading screen, which is strictly worse. The function's
own `CONTRACT:` comment states this directly: "Nothing in this file throws, for any input."

## A second, sharper trap found while fixing it

`@ngx-env/builder` defines only the exact dotted expressions it can see statically
(`import.meta.env.NG_APP_WS_URL`, and so on) in esbuild — it never defines `import.meta.env` as
an object. So passing the bare object, destructuring it, or indexing it with a computed key
produces a bundle where every value reads `undefined` and the app runs silently on its
fallbacks — **the same failure class the fix was addressing.** Each variable must be spelled
out as a full dotted access; `APP_CONFIG`'s own construction site carries a `CONTRACT:` comment
recording this. This is a sibling trap to
[[2026-09-04-a-build-time-env-var-absent-at-build-time-is-a-live-lookup]]: both are ways
`@ngx-env/builder`'s static-inlining model turns a config mistake into something that looks
like working code.

## Also record: a validation library was tried here and removed

Zod was tried for this parse and then removed. The hard requirement "must never throw at
module scope" forced every field to `.catch(undefined)` with a fallback, so the schema
rejected nothing — it only degraded, which the hand-written code already did. It cost +61 kB
raw / +13.5 kB transfer in the critical bootstrap path for zero behavioural difference; the 15
tests written against the schema passed unchanged against the three-line replacement helper,
which is the proof. The value here — the warning, the pure function, optional types in
`env.d.ts` — came free without it. The general rule: a validation library earns its weight when
it *rejects* input; if a hard "never fail" requirement reduces it to coercion with a fallback,
it is a dependency carrying no job.

## Related

- [[2026-09-10-in-app-notifications-design]] — the milestone this config gap was found during;
  its plan's browser-verification step is the one that would have caught this had it run.
- [[env-files]] — the generated-env-file convention whose gap (`.env` hand-maintained,
  `.env.local.web` generated, nothing bridging or warning) is why the mismatch was possible.
- [[testing]] — three-layer testing convention; this defect was invisible to unit tests and
  only surfaced under a real browser E2E exercising the actual push.
- [[2026-09-04-a-build-time-env-var-absent-at-build-time-is-a-live-lookup]] — a sibling
  `@ngx-env/builder` trap from the same config file, where an unset variable becomes a live,
  throwing lookup instead of a silent default.
- [[code-comments]] — the `CONTRACT:`/`WHY:` tags `app-config.ts` uses to record both the
  "never throw at module scope" rule and the dotted-access requirement.
