---
trigger: manual
---

# Testing — three layers per endpoint

Every new or changed HTTP endpoint requires **all three** layers before it is
done:

1. **Unit / integration** — the handler and its collaborators.
2. **Internal E2E** — against the service URL directly.
3. **Gateway E2E with a real Cognito JWT** — the URL the user actually hits.

## Why the third layer is not optional

In-process and internal tests fake the authorizer and never touch the API
gateway, so they cannot see gateway-only bugs:

- a route that was never registered on the gateway
- a path parameter dropped in the gateway mapping
- an HTTP method mismatch between gateway and service

An endpoint without gateway E2E is an **incomplete change**, not a change
pending a nice-to-have.

Per-service specifics live in each `services/<svc>/CLAUDE.md` (or the equivalent
service instruction file), section 2b.

## Mocks hide schema bugs

Mocked unit tests pass happily while the real schema or driver rejects the
write. Verify persistence paths against a live database, not only a mock.

## Assertions must name what they saw

Count-only assertions ("got 3 of 4") cannot distinguish a broken system from a
wrong expectation. Print **what** arrived, not just how many.