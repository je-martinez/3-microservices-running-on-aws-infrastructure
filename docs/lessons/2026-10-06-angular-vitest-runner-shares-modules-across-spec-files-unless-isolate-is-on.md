---
title: "Angular's Vitest runner shares modules across spec files unless isolate is on"
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
  - "[[testing]]"
  - "[[browser-rum]]"
  - "[[angular-component-authoring]]"
---

# Angular's Vitest runner shares modules across spec files unless isolate is on

`apps/web`'s unit-test target sets `"isolate": true` (`angular.json` → `projects.web.architect.test.options`). **Do not remove it.** The Angular unit-test builder defaults `isolate: false`, and Vitest only resets the module graph between files in a worker when isolation is on. Without it, a module evaluated by an earlier spec file stays bound to **that file's** mocks or real dependencies, and a later file's `vi.mock()` of the same dependency never reaches it.

## Symptom

`rum-sdk.spec.ts > registers a callback for every vitals metric` failed intermittently, only in the full suite: `expected "vi.fn()" to be called 1 times, but got 0 times`. The count was 0, not 2, which points at a different mock instance rather than stale counts. Run alone it never failed (0 of 15 runs).

Whether it fails depends on worker assignment. It fails when `rum.spec.ts`, `rum-navigation.spec.ts` or `rum-propagation-interceptor.spec.ts` runs earlier in the same worker (the latter two reach `rum-sdk` through `initRum`'s dynamic import). The reverse order breaks `rum.spec.ts` too.

## Evidence

A custom Vitest sequencer forcing file order on one worker reproduced it deterministically: it failed with `isolate: false` in three orders, and passed 250 of 250 runs with `isolate: true`.

`vi.resetModules()` inside the spec looked like a fix and was not. It clears the whole worker's registry, so later files broke: duplicate `@opentelemetry/sdk-logs` instances made `toBeInstanceOf(LoggerProvider)` fail, and `app-layout.spec.ts` leaked state, because Angular's TestBed initialisation is guarded by a `globalThis` flag that the reset does not clear.

## Cost

Measured over 3 runs each of the 719-test web suite: about 14.5 s without isolation, about 39.5 s with it. Accepted deliberately on 2026-10-06 over rewriting the RUM specs (see [[browser-rum]]).

## Related

- [[testing]]
- [[browser-rum]]
- [[angular-component-authoring]]
- [[2026-10-06-test-skip-inside-test-step-aborts-the-whole-test]]
