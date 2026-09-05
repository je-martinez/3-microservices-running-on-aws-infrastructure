---
title: "A build-time env var absent at build time is not missing — it becomes a live browser lookup that throws"
type: lesson
area: shared
status: active
created: 2026-09-04
updated: 2026-09-04
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/medium
  - issue/JE-237
related:
  - "[[2026-09-04-web-gateway-integration-design]]"
  - "[[env-files]]"
  - "[[testing]]"
  - "[[web-gateway-integration-milestone]]"
---

# A build-time env var absent at build time is not missing — it becomes a live browser lookup that throws

## Finding

`@ngx-env/builder` inlines an `NG_APP_*` variable into the compiled bundle only when that
variable is present **at build time**. One the builder cannot see is not simply left undefined
or defaulted — it is left as a literal, un-inlined `import.meta.env.NG_APP_*` expression in the
shipped JavaScript. In a browser, `import.meta.env` on that key is `undefined`, and evaluating
`import.meta.env.NG_APP_API_GATEWAY_URL` **throws** before Angular finishes bootstrapping. The
symptom is a blank page, not a visibly missing feature flag or a console warning pointing at
the cause.

## Real occurrence

`docker-compose.yml` passed `NG_APP_API_GATEWAY_URL` as a Docker build arg, but
`apps/web/Dockerfile` declared no matching `ARG`/`ENV` to receive it. The build succeeded ---
`@ngx-env/builder` never saw the variable, so it had nothing to inline and raised no build-time
error either. The compiled config, read directly out of the built bundle, showed the exact
split:

```js
{stripeEnabled: !1, apiGatewayUrl: import.meta.env.NG_APP_API_GATEWAY_URL || "/v1"}
```

`stripeEnabled` came from a variable the Dockerfile DID declare, so the builder inlined its
literal value (`!1`, i.e. `false`). `apiGatewayUrl` came from the one it didn't, so it stayed a
live expression. The `|| "/v1"` fallback, written specifically to guard this case, **never ran**
— a JS `||` only evaluates its right side after evaluating the left, and the left side throws
before `||` gets the chance to fall back.

## Why nothing caught it before a real browser did

- **Unit tests passed.** Vitest never evaluates the actual built bundle's `import.meta.env`
  lookups the way a browser does; it exercises the source, where the config value is whatever
  the test environment injects.
- **The build succeeded cleanly.** `@ngx-env/builder` silently inlines what it can see and
  silently leaves what it can't — there is no error, warning, or build-time signal that a
  variable meant to be inlined wasn't.
- **The proxy answered 200.** `curl`ing the running container's root route returns the SPA's
  HTML shell fine; the throw happens inside client-side JavaScript execution, which a
  server-side health check never exercises.

None of the three surfaces this project normally checks — unit tests, a clean build, a 200 from
the proxy — exercises `import.meta.env` the way an actual browser evaluating the bundle does.
**Only loading the built container in a real browser exposed the blank page.**

## Rule

Every `NG_APP_*` variable the app reads at runtime needs **both** an `ARG` and a matching `ENV`
declared in `apps/web/Dockerfile` — declaring only one half (passing it from compose without
receiving it in the Dockerfile, or vice versa) reproduces this exact failure. A **built-container
smoke check** — loading the actual produced image in a real browser and confirming it renders —
is the only verification step that would have caught this, and is worth treating as a mandatory
step whenever a new `NG_APP_*` variable is introduced, not merely a nice-to-have.

## Related

- [[2026-09-04-web-gateway-integration-design]] — the phase-2 design introducing
  `NG_APP_API_GATEWAY_URL`, the variable this bug was found on.
- [[env-files]] — the generated-env-file convention `NG_APP_API_GATEWAY_URL` flows through via
  `make env-file`.
- [[testing]] — three-layer testing convention; this defect was invisible to all three existing
  layers and needed a fourth check (a built-container browser smoke test).
- [[web-gateway-integration-milestone]] — the milestone this lesson was found during.
