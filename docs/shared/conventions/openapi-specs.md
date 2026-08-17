---
title: OpenAPI specs
type: convention
area: shared
status: active
created: 2026-08-14
updated: 2026-08-14
tags: [type/convention, area/shared, status/active]
related:
  - "[[versioning]]"
  - "[[testing]]"
  - "[[mcp-servers]]"
  - "[[openapi-autogen]]"
  - "[[local-dev]]"
---

# OpenAPI specs

## Rule

Every HTTP service commits `services/<svc>/openapi.yaml` at its service root. It is a
**generated, committed build artifact** — never hand-written and never hand-patched. It is
the contract imported into Apidog (Users, Tracking) / Datadog (Orders); see [[mcp-servers]].

**Why generated:** a hand-maintained spec drifts from the real routes the moment a router
changes, and nothing catches it until a consumer builds against it. This reasoning is
recorded in full in [[openapi-autogen]] (Users' ADR) — reference it, don't restate it.

## Per-service generator (all three, verified 2026-08-14)

| Service | Stack | Command | Mechanism |
|---|---|---|---|
| Users | Fastify + Zod | `pnpm generate:openapi` | `@fastify/swagger` + `fastify-type-provider-zod`; entrypoint `src/features/users/http/generate-openapi.ts` |
| Orders | .NET Minimal APIs | `dotnet build` (no separate step) | `Microsoft.Extensions.ApiDescription.Server` emits JSON at build time, then the `ConvertOpenApiToYaml` MSBuild target runs `tools/openapi-json-to-yaml.cs` to re-serialize as YAML 3.1 |
| Tracking | FastAPI | `docker compose run --rm --no-deps -e E2E_TESTING_ENABLED=true --entrypoint python tracking scripts/generate_openapi.py` | FastAPI's native `app.openapi()`, serialized with PyYAML |

Tracking runs its generator **inside the container** because `services/tracking` has no
`.venv` and the repo-root make targets never create one (`make migrate-tracking` runs
Alembic in a one-off container for the same reason; see [[local-dev]]). PyYAML is declared
in `requirements.txt` (dev/generation only), deliberately NOT in `requirements-runtime.txt`
— the runtime image needs no YAML writer since the committed file is what consumers read.

## Document-level metadata

All three services state this identically as of the 2026-08-14 alignment pass:

- **`info.version: 1.0.0`** — the API's version, per [[versioning]]. For Orders this is
  distinct from the OpenAPI *document name* `v1`, which is a generator detail that produces
  a clean `openapi.json` and must stay as it is.
- **`info.description`** — one paragraph naming the stack and how identity arrives.
- **`servers:`** — the local base URL with description `"Local (docker compose / Floci)"`.
  Users `http://localhost:3000`, Orders `http://localhost:3001`, Tracking
  `http://localhost:3002`. Without it a consumer importing the file has no host to send to.

## Tags

`health` and `e2e` are their own tags in every service — the liveness probe is not a
business operation, and the flag-guarded cleanup route must be spottable as test-only
without reading the summary (see [[testing]] for the `e2e-cleanup` mechanism those routes
implement). Business-domain tags stay per service (`users`, `trackings`, `carrier`,
`Orders`, `Products`).

> [!note] Known inconsistency, left alone deliberately
> Orders' two business tags are PascalCase (`Orders`, `Products`) while the rest of the repo
> is lowercase. Renaming them would break existing Datadog groupings for no contract
> benefit, so this inconsistency stays.

## Auth is documented per route, never as a global `securitySchemes` block

None of the three services declares a `securitySchemes` block. Each surface declares its own
header parameter instead, because the schemes are genuinely different and conflating them is
a security problem, not a style one:

- The gateway-injected `x-user-id` (carries the Cognito *sub*, not the internal `usr_` id).
- Tracking's external carrier `x-api-key`.
- Unauthenticated surfaces (health, e2e-cleanup), which declare neither.

`services/tracking/CLAUDE.md` §5a is the detailed reference for its three schemes.

**The E2E flag is ON during generation** so the spec documents the full contract, including
the flag-guarded cleanup route. Generating it does not enable that route anywhere a request
can reach.

## Declare the failures the framework cannot infer

Generators infer only the success shape plus validation errors. Any status raised by a
dependency or inside a handler — a `401` from an auth dependency, a `404` from a not-found
guard, a `400` from a hand-rolled check — appears in the document **only if the route
declares it**.

Concrete example worth recording: Tracking's two user-scoped reads shipped without declaring
their `401`, so the spec advertised a `200`-or-`422` surface for endpoints that reject an
anonymous caller outright. Fixed 2026-08-14.

## The drift guard

A committed artifact goes stale silently, so each service pins it with a test that
regenerates and compares:

- **Users** — `tests/features/users/http/routes.test.ts` ("openapi spec generation").
- **Tracking** — `tests/test_openapi_spec.py`. Compares **parsed** documents, not raw text —
  a re-wrapped description is not a contract change; it also pins per-route auth headers and
  the documented `401`s.

> [!warning] Gap — Orders currently has no equivalent staleness test
> Its `openapi.yaml` regenerates on every `dotnet build`, which makes drift unlikely but not
> impossible for someone who never builds before committing.

## The rule for contributors

Any change to a route, its schema, its status codes, or its tags MUST regenerate and commit
`openapi.yaml` in the same change. A route change without a matching spec update is an
incomplete change — same standing as the three-layer testing rule in [[testing]].

## Related

- [[versioning]] — `info.version` follows this convention's API-versioning rule.
- [[testing]] — the three-layer testing rule this note's "incomplete change" standard mirrors,
  and the `e2e-cleanup` mechanism behind the `e2e` tag.
- [[mcp-servers]] — Apidog/Datadog, the consumers this generated contract is imported into.
- [[openapi-autogen]] — Users' ADR with the full drift-vs-generation rationale.
- [[local-dev]] — why Tracking's generator runs inside a container rather than a local `.venv`.
