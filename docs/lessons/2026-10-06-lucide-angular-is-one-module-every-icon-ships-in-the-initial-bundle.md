---
title: "@lucide/angular is one module — every registered or imported icon ships in the initial bundle"
type: lesson
area: shared
status: active
created: 2026-10-06
updated: 2026-10-06
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/medium
related:
  - "[[browser-rum]]"
  - "[[angular-component-authoring]]"
  - "[[testing]]"
---

# @lucide/angular is one module — every registered or imported icon ships in the initial bundle

`@lucide/angular` is published as a single module, and the bundler splits by whole module. So the icon set used anywhere in the app lands in whichever chunk is initial (the header imports icons), and an icon used only by a lazy route still costs about 3.3 kB in the **initial** bundle, because each icon carries its compiled template. Register or import only icons that are actually used, and delete leftovers when a feature is removed.

## Symptom

Adding two icons (`circle-alert`, `rotate-cw`) to the lazy profile save-error banner moved the initial total from 591.0 kB to 597.6 kB against the 600 kB budget in `angular.json`. The icons appeared in the shared initial chunk, not in the lazy profile chunk.

## Evidence

A source-map measurement put `@lucide/angular` at about 153 kB of the roughly 347 kB shared initial chunk (46 icons). Removing four registered-but-unused icons from `app.config.ts` (`apple`, `chevron-down`, `link`, `sparkles`, leftovers of the removed Apple Pay and Link tabs) saved 12.70 kB. Together with a type-only `SeverityNumber` import in `rum-error-handler.ts` (-2.26 kB, `@opentelemetry/api-logs` out of main), the initial total went from 597.60 to 582.64 kB. A follow-up made `rum-propagation-interceptor.ts` OTel-free, so `@opentelemetry/api` ships in the lazy `rum-sdk` chunk and the initial total is 556.05 kB (main 161.16 kB); the rule is in [[browser-rum]].

`pnpm build` is the only check that sees this: the budget is a build gate, not a test or lint rule (see [[browser-rum]]).

## Noted, not done

- Icons used only by name through `LucideDynamicIcon` could avoid component classes.

## Related

- [[browser-rum]]
- [[angular-component-authoring]]
- [[testing]]
