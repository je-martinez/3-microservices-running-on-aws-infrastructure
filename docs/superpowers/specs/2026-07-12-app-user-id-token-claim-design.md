---
title: app_user_id token claim via Pre-Token-Generation trigger
type: spec
area: users
status: draft
created: 2026-07-12
updated: 2026-07-12
tags:
  - type/spec
  - area/users
  - status/draft
related:
  - "[[ADR-0010-cognito-auth]]"
  - "[[ADR-0017-floci-local]]"
  - "[[users-service-design]]"
---

# app_user_id token claim via Pre-Token-Generation trigger

## Goal

Put the Prisma `usr_` id into the Cognito token as an `app_user_id` claim,
sourced from a Cognito **custom attribute** (`custom:app_user_id`) that
`register` sets, copied into the token by a **Pre-Token-Generation Lambda
trigger (V2)**.

**INVARIANT — do not change identity resolution.** `x-user-id` stays the Cognito
`sub` (injected by nginx+njs, Gap 1); the service still resolves users by
`cognitoSub` (Gap 2, `db.user.findByIdOrCognitoSub`). This spec ONLY ADDS a new
`app_user_id` claim — it does not touch `x-user-id`, the nginx njs script, or the
service's lookup logic.

## Verified feasibility (from earlier POCs this session)

- Pre-Token-Generation **V2** trigger DOES fire in Floci — a Lambda added a
  custom claim that appeared in BOTH the id and access tokens. (This is distinct
  from PostConfirmation/PreSignUp, which do NOT fire — see the note in
  `register.ts`. The "triggers never invoked" statement there is about
  PostConfirmation, not Pre-Token-Generation.)
- Custom attributes are emitted by Floci and readable in the Pre-Token event's
  `request.userAttributes`.

## Design

### 1. Cognito custom attribute (`infra/modules/cognito/main.tf`)

Add to `aws_cognito_user_pool.this`:
```hcl
  schema {
    name                = "app_user_id"
    attribute_data_type = "String"
    mutable             = true
    string_attribute_constraints {
      min_length = 1
      max_length = 64
    }
  }
```
Add `custom:app_user_id` to the client's read/write attributes. The module forks
client creation via `manage_client_via_provider` (native for prod; awscli
fallback for Floci — local uses `= false`). The schema lives on the POOL (common
to both). If read/write attribute lists are set on the client, mirror
`custom:app_user_id` in BOTH the native `aws_cognito_user_pool_client` and the
awscli-fallback create call.

> Constraint: Cognito custom attributes are immutable at the schema level (can't
> remove/retype after creation). Adding `app_user_id`/String is a one-way prod
> decision; locally Floci re-mints the pool each apply, so it's moot there.

### 2. `register` sets the attribute at sign-up (reorder)

Today `register.execute` calls `signUp(email, password)` FIRST, then does
`const id = generateId(MODEL_ID_PREFIXES.User)`. To pass the id into the
attribute, generate it BEFORE `signUp`:

- Change `AuthProvider.signUp` to `signUp(email, password, appUserId): Promise<CognitoSignUpResult>`.
- In `CognitoAuthProvider.signUp`, add `{ Name: "custom:app_user_id", Value: appUserId }`
  to `AdminCreateUserCommand.UserAttributes` (next to email/email_verified).
- In `register.execute`, move the `const id = generateId(...)` line ABOVE the
  `signUp` call and pass it:
  ```ts
  const id = generateId(MODEL_ID_PREFIXES.User);
  const signUp = await this.auth.signUp(input.email, input.password, id);
  // ...unchanged: runAsActor(id, () => db.user.create({ data: { id, cognitoSub: signUp.sub, ... }}))
  ```
  The rest of `execute` already uses `id` (row id + `runAsActor` actor) — only
  its declaration moves up. `signUp.sub` is still stored as `cognitoSub` as
  today. The best-effort local identity-capture block below stays unchanged.

### 3. Pre-Token-Generation Lambda (V2) — first Lambda in the repo

No `aws_lambda_function` exists yet, so this establishes the packaging/deploy
pattern. Handler (reads the attribute from the event, copies it to the claim; NO
DB access):
```js
export const handler = async (event) => {
  const appUserId = event.request.userAttributes["custom:app_user_id"];
  const claims = appUserId ? { app_user_id: appUserId } : {};
  event.response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration:     { claimsToAddOrOverride: claims },
      accessTokenGeneration: { claimsToAddOrOverride: claims },
    },
  };
  return event;
};
```
If the attribute is absent (legacy user), it adds nothing — safe.

Infra (in `infra/modules/cognito/`, or a small dedicated lambda submodule — the
implementer follows repo module conventions):
- `data "archive_file"` zipping the handler source (a checked-in `.mjs` under the
  module, e.g. `infra/modules/cognito/pre-token-lambda/index.mjs`).
- `aws_lambda_function` (runtime nodejs20.x, handler `index.handler`) with an
  execution role — a bare role with basic-execution (CloudWatch Logs) is enough;
  NO VPC/DB access.
- `aws_lambda_permission` allowing principal `cognito-idp.amazonaws.com` to
  invoke it.
- Wire it on the pool:
  ```hcl
  lambda_config {
    pre_token_generation_config {
      lambda_arn     = aws_lambda_function.pre_token.arn
      lambda_version = "V2_0"
    }
  }
  ```

## Testing

Unit:
- `CognitoAuthProvider.signUp` passes `custom:app_user_id = <appUserId>` in
  `UserAttributes` (mock asserts the attribute is present).
- `register.execute` generates the id before calling `signUp` and passes it
  (mock `auth.signUp` asserts it received the generated `usr_` id; the created
  row's `id` equals it).
- Pre-Token Lambda handler: given `request.userAttributes["custom:app_user_id"]`,
  returns `claimsAndScopeOverrideDetails` adding `app_user_id` to both tokens;
  given none, adds nothing.
- Existing suite stays green (login/refresh/me/webhook unaffected).

E2E (teardown + rebuild — pool schema + Lambda change; Floci 2nd-apply limit →
`make bootstrap`; NEEDS the user's explicit OK):
- Register a user, log in, DECODE the id token → it contains
  `app_user_id = usr_…` matching the registered user's id.
- **Invariant checks:** `GET /v1/users/me` with `Authorization: Bearer <token>`
  still returns 200 (x-user-id path unchanged); nginx still injects the sub;
  register/login/refresh still 201/200/200. Confirm the Lambda's `/aws/lambda/…`
  log group shows it fired.

## Non-goals (YAGNI)

- Do NOT change `x-user-id` (stays the sub), the nginx njs script, or
  `findByIdOrCognitoSub`. Identity resolution is untouched.
- The Lambda does NOT query the DB (attribute-sourced only).
- No backfill of `custom:app_user_id` for pre-existing users (new registrations
  get it; a backfill can be a follow-up).
- No consumer of the `app_user_id` claim yet — this spec only makes it available
  in the token. (Whoever wants it later reads it from the JWT.)

## Consequences

- **First Lambda deployment in the repo** — establishes the Terraform pattern
  (archive_file + function + role + permission) for future Lambdas
  (events-pipeline, etc.).
- Cognito now stores the app `usr_` id (via the custom attribute), coupling the
  IdP to the app id by design — but ONLY additively; the sub remains the primary
  identity on the wire.
- Corrects a narrow point in the codebase's mental model: Pre-Token-Generation
  triggers DO fire in Floci (unlike PostConfirmation). Worth a one-line note near
  the `register.ts` "triggers never invoked" comment.

## Related

- [[ADR-0010-cognito-auth]]
- [[ADR-0017-floci-local]]
- [[users-service-design]]
