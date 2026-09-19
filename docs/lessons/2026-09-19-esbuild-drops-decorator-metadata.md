---
title: "esbuild drops design:paramtypes — Nest type-based DI injects undefined while tsc builds work"
type: lesson
area: users
status: active
created: 2026-09-19
updated: 2026-09-19
tags:
  - type/lesson
  - area/users
  - status/active
  - severity/high
related:
  - "[[2026-09-19-users-nestjs-migration-design]]"
  - "[[2026-09-19-users-nestjs-migration]]"
  - "[[dependency-injection]]"
  - "[[users-service-design]]"
  - "[[testing]]"
---

# esbuild drops design:paramtypes — Nest type-based DI injects undefined while tsc builds work

## Finding

NestJS type-based DI (`constructor(private readonly db: PrismaService)`) reads
`Reflect.getMetadata("design:paramtypes", …)`. That metadata is emitted only when the
toolchain runs with `emitDecoratorMetadata` / `decoratorMetadata: true`.

**esbuild does not emit it.** Both `tsx` and Vitest's default transform are esbuild-powered.
Measured on 2026-09-19 (Node 24.18.0):

| Toolchain | `Reflect.getMetadata("design:paramtypes", B)` | Nest type-based DI |
|---|---|---|
| `tsx` (esbuild) | `undefined` | `this.db` is `undefined` at runtime |
| Vitest (esbuild) | `undefined` | same failure |
| `tsc --emitDecoratorMetadata` | e.g. `"1:CascadeClient"` | works |

The failure is **asymmetric and silent**: `pnpm build` (tsc) produces a working service, while
`pnpm dev` and the entire unit suite break — or, worse, resolve the wrong dependency and fail
only when a constructor argument is actually used. The Nest bootstrap error that finally
surfaced under `tsx` was of the form *"Nest can't resolve dependencies of DeleteAccountHandler
… argument at index [1]"*, not a compile-time refusal.

## Why it was expensive

The migration plan fixed Vitest with `unplugin-swc` + a shared `.swcrc`
(`decoratorMetadata: true`) and assumed that was enough. Dev scripts still ran through `tsx`,
so the suite went green while `pnpm dev` died at bootstrap. The gap only closed when the same
SWC path was applied to the runtime: `node --import @swc-node/register/esm-register` for
`dev` and `generate:openapi`, reading the **same** `.swcrc`. `start` already ran tsc output and
was never affected.

## Guard

`services/users/tests/di-metadata.test.ts` is a canary: it asserts that type-based DI resolves
through `CommandBus` under the real Vitest+SWC toolchain. It fails the moment metadata stops
being emitted. Do not "simplify" the toolchain back to plain esbuild/tsx without that test
going red first.

## How to apply

- For any NestJS package in this repo: Vitest via `unplugin-swc`, and any TypeScript-source
  runtime entry (dev / one-shot scripts) via `@swc-node/register`, both sharing one `.swcrc`
  with `decoratorMetadata: true`. Do not mix esbuild transforms with Nest type-based DI.
- `@Inject(TOKEN)` remains only for interfaces / type aliases that have no runtime class
  (`Db`, `AuthProvider`, `EventPublisher`, Redis clients). Prefer positional constructors for
  concrete classes — but only when the toolchain actually emits paramtypes.
- A green `tsc` build is **not** evidence that `dev` or Vitest can inject by type.

## Related

- [[2026-09-19-users-nestjs-migration-design]] — the migration that hit this.
- [[2026-09-19-users-nestjs-migration]] — plan DI-1 and the SWC toolchain lock-in.
- [[dependency-injection]] — Users' Nest provider rules after the migration.
- [[users-service-design]] — current Users stack.
- [[testing]] — unit tests must run under the same metadata-emitting transform as production intent.
