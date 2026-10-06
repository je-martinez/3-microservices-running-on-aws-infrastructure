---
title: "Curl the real response before writing a stub"
type: lesson
area: shared
status: active
created: 2026-10-06
updated: 2026-10-06
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/low
related:
  - "[[testing]]"
  - "[[count-only-assertions-hide-cause]]"
  - "[[2026-09-04-web-gateway-integration-design]]"
---

# Curl the real response before writing a stub

Before stubbing an HTTP response in a test (`page.route`, mocks), read the real status and body from the running stack with `curl` and copy them. Never invent them.

## Symptom

A stub with an invented status exercises an error path the app never sees in reality, so the test can pass while the real path is broken, or the reverse.

## Evidence

2026-10-06, reproducing the dead-session redirect bug. The stub answered `POST /v1/users/refresh` with 400 `invalid_refresh_token`. The real answers are:

- Users: 401 `{"error":"invalid_credentials"}`.
- Gateway, for authenticated calls: 401 `{"message":"Unauthorized"}`.

It changed nothing there only because the client treats every refresh error the same (`catchError` leading to `discard()`). The final spec, `e2e/tests/web/stale-session.spec.ts`, uses the real bodies.

## Related

- [[testing]]
- [[count-only-assertions-hide-cause]]
- [[2026-09-04-web-gateway-integration-design]]
