---
title: "Users tests are not type-checked by anything"
type: lesson
area: users
status: active
created: 2026-10-02
updated: 2026-10-02
tags:
  - type/lesson
  - area/users
  - status/active
  - severity/medium
related:
  - "[[testing]]"
  - "[[users-service-design]]"
---

# Users tests are not type-checked by anything

> [!warning] Open gap, not fixed
> As of 2026-10-02 no tool type-checks `services/users/tests/`.

## Symptom

A Users test with a wrong type, or a stale import signature, compiles and runs. Nothing flags it.

## Cause

- `services/users/tsconfig.json` has `"include": ["src/**/*.ts"]` and `"rootDir": "src"`, so `tsc` (and
  therefore `pnpm build`) never sees a test file.
- Vitest transforms through SWC (`unplugin-swc`), which strips types without checking them.
- Adding the tests to a temporary tsconfig does not work either: the `#shared/*`, `#features/*` and
  `#config/*` subpath imports in `package.json` `imports` resolve to `./dist/...` under the `default`
  condition, and only to `./src/...` under `development`. `vitest.config.ts` carries its own `resolve.alias`
  table for these, which `tsc` does not read. The `#…` imports fail to resolve, both from `src` and from
  the tests.

## Consequence

A green `test` run says the tests execute, not that they are type-correct. A signature change in `src`
can leave a stale call in a test that still passes at runtime until the argument is actually used.

## Open question

A dedicated tsconfig for tests needs either the `development` condition (`customConditions`) or `paths`
that mirror the vitest aliases. Neither is in place, and no issue tracks it.

## Related

- [[testing]]
- [[users-service-design]]
