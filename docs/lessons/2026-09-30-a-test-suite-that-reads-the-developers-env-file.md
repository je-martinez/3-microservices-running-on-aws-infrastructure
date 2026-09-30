---
title: "A test suite that reads the developer's env file: 30 failures on one machine, green on another"
type: lesson
area: shared
status: active
created: 2026-09-30
updated: 2026-09-30
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/high
related:
  - "[[testing]]"
  - "[[env-files]]"
  - "[[local-dev]]"
  - "[[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]"
---

# A test suite that reads the developer's env file

`apps/web`'s Vitest suite reported 30 failures in `checkout-payment.spec.ts` on one machine and passed on another. The tests were correct and the product code was correct. The suite was reading the **developer's generated env file**.

## The chain

Each link was verified.

1. `angular.json`'s `build` target sets `ngxEnv.files: ["../../.env.local.web", ".env"]`.
2. The `test` target uses `@ngx-env/builder:unit-test`, which has **no** `ngxEnv` option of its own. Its schema sets `additionalProperties: false` and rejects one (`Schema validation failed ... must NOT have additional properties(ngxEnv)`, verified by trying it). It derives its env from its `buildTarget`, which defaults to `::development`.
3. The test run therefore inherited the build's env resolution. `.env.local.web` is git-ignored and generated per developer by `make env-file` (see [[env-files]]); on the failing machine it had `NG_APP_STRIPE_ENABLED=true`.
4. `app-config.ts` parses `NG_APP_*` once at module scope into `APP_CONFIG`.
5. `checkout-payment.html`'s `@if (stripeEnabled())` renders the Stripe branch, and the plain-card inputs in the `@else` never exist.

The real error was `No card input with test id card-number`. It is not a sanitising or Signal Forms problem, which is where a reader looks first.

## Regression point

Commit `f945f0c9` (2026-09-29, same feature branch). Before it, `ngxEnv` declared only a `prefix` and read no files, so tests saw every flag undefined, i.e. false, and passed. The commit added `files:` for a real reason: `pnpm dev` and the container had diverged.

**The commit is not wrong; it exposed a latent test defect.** Its message even states the resolution applies to "`ng build`, `ng serve` and `pnpm test` alike", so the inheritance was understood. The suite was simply not re-run afterwards. The gap was verification, not knowledge.

## Proof of causation

One variable: restoring only the pre-commit `angular.json` over the current tree made the suite 604/604.

Only `stripeEnabled` actually breaks the suite. The full 2x2 matrix:

| `stripeEnabled` | `geocodeEnabled` | result |
| --- | --- | --- |
| false | false | 604/604 pass |
| false | true | 604/604 pass |
| true | false | 30 failures |
| true | true | 30 failures |

`geocodeEnabled` is orthogonal in both positions: `street-autocomplete.spec.ts` sets the flag
BEFORE creating its fixture, because the constructor reads it once, so it is already immune.

> [!warning] A measurement that overrides one variable still inherits the others
> An earlier run overrode only `NG_APP_GEOCODE_ENABLED` and reported "30 different failures",
> concluding geocode was a second trap. It was not: `stripeEnabled` stayed `true` from the env
> file, so those were the SAME stripe failures — same count, same file. The only thing that
> moved was which spec the scheduler happened to hand the cascade to. **Override every variable
> in the matrix, or the run measures the ambient value you forgot.**

## The amplifier: teardown order

Only **13** of the 30 failures were branch-dependent. The other 17 were cascade:

- `afterEach` ran `controller.verify()` **before** `TestBed.resetTestingModule()`.
- `verify()` throws on an unexpected open request, the throw skips the reset, and every later test dies in `beforeEach` with "Cannot configure the test module when the test module has already been instantiated". It spilled into other spec files sharing the worker.
- Fix: `try { verify() } finally { resetTestingModule() }`. The same inversion existed in `cart-drawer.spec.ts`.

Proven by canary: a test made to throw mid-run now fails alone (1 failed, 604 passed) where it previously took 17 others with it.

## Why this is severity/high

Two of the 13 assert a **negative**: that no `POST /v1/orders` is issued while the plain card form is invalid. `checkout-payment.ts`'s `canPay` is `(stripeEnabled() || cardForm().valid())`, so with the flag on that term short-circuits and the gate under test is never evaluated.

**The suite had silently stopped testing the plain-branch pay gate.** This is the same structural invisibility described in [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]: green tests covering something other than what they claim.

## The fix and the alternative rejected

A `test` configuration on the `build` target whose only difference is `ngxEnv.files: []`, with the test target pointing at it via `buildTarget: "::test"`. One edit. `production` and `development` inherit the original `files` untouched, verified by the publishable key still being inlined into the built bundle.

Verified immune across three flag combinations (both on, both off, mixed): 604/604 each time.

**Rejected alternative:** hard-coding a `false` baseline in each spec that captures ambient
config. Four files do (`checkout-payment.spec.ts`, `cart-drawer.spec.ts`, `profile.spec.ts` for
`stripeEnabled`; `street-autocomplete.spec.ts` for `geocodeEnabled`), and only the first is
failing today — the other three are the same idiom waiting for a flag to flip. That is the
reason to pin the environment rather than the specs: one edit removes the whole class, while a
per-spec baseline asks for a new correct decision every time a flag is added, and cannot stop a
fifth spec reintroducing it. Flags already in play: `rumEnabled`, `wsUrl`,
`stripePublishableKey`.

The cost is real and worth stating: the test environment now differs from the build environment
by design, so the suite can no longer catch a bug that only appears when a flag is ON. A spec
that needs a flag on must turn it on explicitly — which is the point, since an assertion states
the branch it exercises where an ambient value only inherits one.

## How to apply

- A unit-test run must not read a generated, git-ignored, per-developer env file. Pin the test environment explicitly.
- A spec that captures ambient config as its baseline (`const X = APP_CONFIG.x`) is environment-dependent by construction, however correct its restore logic.
- Teardown that can throw must not guard a reset: use `try/finally`.
- After changing how **any** environment is resolved, re-run the suites. The blast radius of an env-resolution change is not visible in the diff.

## Related

- [[testing]]
- [[env-files]]
- [[local-dev]]
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]
