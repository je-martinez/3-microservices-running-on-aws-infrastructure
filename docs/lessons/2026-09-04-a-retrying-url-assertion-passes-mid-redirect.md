---
title: "A retrying URL assertion can pass mid-redirect, before a guard's eviction finishes"
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
  - issue/JE-245
related:
  - "[[2026-09-04-web-gateway-integration-design]]"
  - "[[testing]]"
  - "[[web-gateway-integration-milestone]]"
---

# A retrying URL assertion can pass mid-redirect, before a guard's eviction finishes

## Finding

Playwright's `toHaveURL` is a retrying assertion: it polls until the URL matches or the timeout
expires. That means it can report **pass** in the exact frame *before* a route guard's redirect
has actually completed — the URL has already changed, but the page has not finished rendering
what that URL implies.

Observed while writing the JE-245 gateway E2E specs for session eviction: with the stored token
deleted, `await expect(page).toHaveURL(/\/orders$/)` **passed** while the page was still
rendering the previous view — the guard's eviction and redirect to `/login` take a few frames to
land, and the assertion sampled a frame where the browser had already navigated to `/login`'s
URL but the DOM had not yet settled into the login form. The very next assertion, checking for
the login heading, failed — because by the time it ran, the guard's async rehydration hadn't
resolved and content was still catching up.

**Rule: in guard/redirect tests, assert the RENDERED CONTENT first, the URL second.** A URL
check alone is not proof the guard finished; a heading, a form field, or another
content-specific assertion is. Ordering the checks content-first also fails faster and closer
to the real defect when a guard genuinely breaks, instead of surfacing as a URL/content mismatch
one assertion downstream.

## Why this matters beyond this spec

Any test asserting a client-side redirect (auth guards, route guards, `router.navigate` inside
an async callback) is vulnerable to this same window. A retrying assertion is designed to
tolerate real async delay, which is correct in general — but it also tolerates and hides a
redirect that is still mid-flight, producing a **false-green window**: the spec would have
passed even if the guard's redirect fired the URL change but never actually finished evicting
the session or rendering the destination. This was caught only by inverting the assertion
order and re-running; with the order inverted, the same specs still pass, but now for the right
reason.

## Related

- [[2026-09-04-web-gateway-integration-design]] — the JE-245 auth-guard/eviction design this
  E2E spec verifies.
- [[testing]] — three-layer testing convention; gateway E2E is the layer this bug was found in.
- [[web-gateway-integration-milestone]] — the milestone this lesson was found during.
