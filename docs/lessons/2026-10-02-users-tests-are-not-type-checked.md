---
title: "Users tests are not type-checked by anything"
type: lesson
area: users
status: accepted
created: 2026-10-02
updated: 2026-10-02
tags:
  - type/lesson
  - area/users
  - status/accepted
  - severity/medium
related:
  - "[[testing]]"
  - "[[users-service-design]]"
---

# Users tests are not type-checked by anything

> [!success] Resolved
> `services/users/tsconfig.test.json` and a `typecheck` script now type-check `src` and `tests`. `make test-unit`
> runs it after the Users unit tests.

## Symptom (before the fix)

A Users test with a wrong type, or a stale import signature, compiles and runs. Nothing flags it.

## Cause (before the fix)

- `services/users/tsconfig.json` has `"include": ["src/**/*.ts"]` and `"rootDir": "src"`, so `tsc` (and
  therefore `pnpm build`) never sees a test file.
- Vitest transforms through SWC (`unplugin-swc`), which strips types without checking them.
- Adding the tests to a temporary tsconfig does not work either: the `#shared/*`, `#features/*` and
  `#config/*` subpath imports in `package.json` `imports` resolve to `./dist/...` under the `default`
  condition, and only to `./src/...` under `development`. `vitest.config.ts` carries its own `resolve.alias`
  table for these, which `tsc` does not read. The `#…` imports fail to resolve, both from `src` and from
  the tests.

## Consequence

Before the fix, a green `test` run said the tests execute, not that they are type-correct. A signature change in
`src` could leave a stale call in a test that still passed at runtime until the argument was actually used.
The `typecheck` gate now catches that class of drift.

## Fix

- `services/users/tsconfig.test.json` extends `tsconfig.json` with `noEmit`, `rootDir: "."`, `include` of `src` and
  `tests`, and `customConditions: ["development"]`.
- `services/users/package.json` has `"typecheck": "tsc -p tsconfig.test.json"`, and `make test-unit` runs it after
  the Users unit tests.
- The first run surfaced 37 type errors in 9 test files and no bug in `src`. They were fixed by typing mocks
  against the real ports, casting partial doubles once in helpers, and aliasing dynamically imported classes as
  types.
- The gate fails on a deliberate type error.

## Mechanism: rootDir and customConditions

Widening `rootDir` to `"."` breaks `tsc`'s mapping of the `package.json` `imports` `default` target (`./dist/*.js`)
back to source, so every `#…` import fails with TS2307 (568 errors). `customConditions: ["development"]` makes
`tsc` read the `development` target (`./src/*.ts`) directly. `package.json` stays the single alias table: `paths`
would add a third copy beside `imports` and the vitest `resolve.alias`, so it is not used.

## Related

- [[testing]]
- [[users-service-design]]
