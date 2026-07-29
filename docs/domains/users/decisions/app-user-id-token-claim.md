---
title: app_user_id token claim via Pre-Token-Generation Lambda
type: adr
area: users
status: accepted
id: users-app-user-id-claim
deciders: ["Jose E. Martinez"]
supersedes: null
superseded-by: null
created: 2026-07-28
updated: 2026-07-28
tags: [type/adr, area/users, status/accepted]
related:
  - "[[users-service-design]]"
  - "[[ADR-0010-cognito-auth]]"
  - "[[ADR-0017-floci-local]]"
  - "[[cognito-pre-token-lambda]]"
  - "[[2026-07-12-app-user-id-token-claim-design]]"
  - "[[2026-07-12-app-user-id-token-claim]]"
---

# app_user_id token claim via Pre-Token-Generation Lambda

## Context

Consumers of a Cognito-issued token (services, gateway, future clients) had no way to
read the Users service's own `usr_`-prefixed id directly from the token — only the
Cognito `sub`. Adding a convenience claim required a way to get the app id into Cognito
at sign-up and copy it into the token, without disturbing existing identity resolution.

## Decision

- `register` reserves the `usr_` id **before** calling Cognito `signUp` (reordered:
  `generateId` moves above the `signUp` call) and passes it through as `appUserId`. This
  lands in a new custom Cognito user-pool attribute, `custom:app_user_id`, at sign-up
  time.
- A **Pre-Token-Generation V2 Lambda** (`infra/modules/cognito/pre-token-lambda/`) —
  the repo's first Lambda — copies `custom:app_user_id` into an `app_user_id` claim on
  both the id and access tokens. It does no DB access; it only reads the attribute
  already present on the trigger event.
- Verified empirically on Floci: Pre-Token-Generation V2 triggers **do** fire locally
  (unlike PostConfirmation, which does not — see [[ADR-0017-floci-local]]).
- **Invariant, deliberately preserved:** `x-user-id` stays the Cognito `sub`; identity
  resolution still goes through `cognitoSub` via
  `db.user.findByIdOrCognitoSub` (see the identity-resolution decision). `app_user_id`
  is purely additive — a read-only convenience claim, not a new identity path.

## Consequences

- Establishes the Terraform pattern for Lambda deployment in this repo (`archive_file` +
  `aws_lambda_function` + execution role + `aws_lambda_permission`) that future Lambdas
  (e.g. events-pipeline) can follow.
- Cognito now stores the app id, coupling the IdP to the app id by design — but only
  additively; the `sub` remains the primary identity on the wire.
- Cognito custom attributes are immutable at the schema level once created — a one-way
  decision in production (moot locally, since Floci re-mints the pool on every apply).

## Related

- [[users-service-design]]
- [[ADR-0010-cognito-auth]]
- [[ADR-0017-floci-local]]
- [[cognito-pre-token-lambda]]
- [[2026-07-12-app-user-id-token-claim-design]]
- [[2026-07-12-app-user-id-token-claim]]
