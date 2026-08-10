---
title: "Open gap: web-app password checklist is stricter than the enforced policy"
type: adr
area: users
status: draft
created: 2026-08-09
updated: 2026-08-09
tags:
  - type/adr
  - area/users
  - status/draft
related:
  - "[[ADR-0020-self-owned-password-reset]]"
  - "[[self-owned-password-reset-codes-in-redis]]"
  - "[[users-service-design]]"
  - "[[ADR-0010-cognito-auth]]"
---

# Open gap: web-app password checklist is stricter than the enforced policy

> [!warning] Deliberately NOT taken — recorded as an open gap, not fixed here
> This note documents a mismatch discovered while shipping the forced password-change screens.
> It is a **product decision that has not been made**, not an implementation bug — do not close
> this by silently tightening the pool or silently loosening the design. Someone has to decide
> which side moves.

## The mismatch

The forced set-new-password frames (`assets/web-app/web-app.pen` — "Set New Password — Forced"
and "Mobile — Set New Password", added on `feat/password-reset-email`, the client half of the
`mustChangePassword` flow) render a password checklist that is **stricter** than what the backend
actually enforces:

| Requirement | Design frame asks for | Backend actually enforces |
|---|---|---|
| Minimum length | 10 characters | 8 characters (Cognito pool `minimum_length = 8`) |
| Mixed case | Required | Not required (`require_lowercase`/`require_uppercase` both `false`) |
| A number | Required | Not required (`require_numbers = false`) |
| A symbol | Required | Not required (`require_symbols = false`) |

The Zod schema on both `ConfirmPasswordResetInput.newPassword` and `ChangePasswordInput.newPassword`
(`services/users/openapi.yaml`) mirrors the pool exactly — `minLength: 8` and nothing else — and
that mirroring is **itself deliberate**, not an oversight: it avoids the far worse failure mode of
two independently-maintained password rules (Cognito's pool policy and a separately-hand-written
Zod rule) silently drifting apart, where a password Zod accepts could still be rejected by
Cognito, or vice versa. So the backend side of this mismatch is consistent and intentional; the
gap is that the **design** was not built to the same number.

## Why this is a real gap, not just an aesthetic inconsistency

If the checklist UI is built exactly as designed, the frontend would **advertise rules the API
does not apply** — a user could satisfy the on-screen checklist's stricter bar, or conversely
could submit a password that fails the *design's* checklist but that the real API would have
happily accepted, producing a UI that lies about what is actually required either direction.

## Recommendation, if this is ever picked up

**Tighten the Cognito pool's `password_policy` to match the design's 10-char/mixed-case/number/
symbol requirement before building the checklist component**, rather than validating the stricter
rule only in the client. Client-side-only validation of a rule the server does not enforce is
exactly the kind of two-copies-that-can-drift problem the Zod-mirrors-the-pool decision above was
already built to avoid — building a client checklist against a policy Cognito doesn't enforce
would reintroduce that same class of problem one layer up. If the product decision instead comes
down on the *design's* checklist being unnecessarily strict, the design should be loosened to
match 8-characters-only instead — either resolution is acceptable, but the two must be made to
agree by moving one side, not by shipping the checklist against a number nobody enforces.

## What is out of scope for this note

This is a recorded gap, not a decision. No pool policy or design change is proposed here — only
the discrepancy and the two ways to close it. Whoever picks up building the actual checklist
component should treat this as the design's or the ADR's blocking question, not as pre-approval
for either direction.

## Related

- [[ADR-0020-self-owned-password-reset]] — the reset flow this checklist belongs to.
- [[self-owned-password-reset-codes-in-redis]] — the `PATCH /v1/users/me/password` /
  `POST /v1/users/password/confirm` endpoints the checklist would gate.
- [[users-service-design]] — where the Zod `minLength: 8` mirroring is documented alongside the
  rest of the service's schemas.
- [[ADR-0010-cognito-auth]] — the base Cognito decision; the pool's `password_policy` block lives
  in `infra/modules/cognito/`.
