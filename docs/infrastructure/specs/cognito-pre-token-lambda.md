---
title: "Cognito app_user_id attribute + Pre-Token-Generation Lambda"
type: spec
area: infra
status: active
created: 2026-07-12
updated: 2026-07-12
tags:
  - type/spec
  - area/infra
  - status/active
related:
  - "[[ADR-0010-cognito-auth]]"
  - "[[ADR-0017-floci-local]]"
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
  - "[[terraform-modules]]"
  - "[[aws-resources]]"
  - "[[awscli-fallback-for-floci]]"
  - "[[2026-07-12-app-user-id-token-claim-design]]"
  - "[[users-service-design]]"
  - "[[nano-id]]"
---

# Cognito app_user_id attribute + Pre-Token-Generation Lambda

## Summary

The Users Cognito User Pool (`infra/modules/cognito/`) carries the app's Prisma `usr_` id as a
custom attribute, and a Pre-Token-Generation **V2** Lambda — the repo's first Lambda — copies
that attribute into an `app_user_id` claim on issued tokens. This closes the gap between Cognito's
identity (`sub`) and the application's own user id, without changing identity resolution:
`x-user-id` (injected by the local nginx+njs proxy, [[ADR-0016-local-apigw-nginx-ecs]]) still
carries the Cognito `sub`, and the service still resolves users by `cognitoSub` via
`byIdOrCognitoSub`. `app_user_id` is an additive, read-only convenience claim.

## The custom attribute

`infra/modules/cognito/main.tf` declares a custom schema attribute on the user pool:

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

- Mutable, 1–64 characters — sized for a prefixed nano-id (see [[nano-id]]).
- Custom attributes are **immutable at the schema level**: once created, the name/type is a
  one-way decision. This is acceptable locally because Floci re-mints the pool on every apply.
- Neither the native `aws_cognito_user_pool_client` resource nor the awscli-fallback client
  script sets explicit `read_attributes`/`write_attributes` — both default to **ALL** attributes,
  so the new custom attribute is automatically writable/readable by the client with no client
  change required.

## Setting the attribute at sign-up

`services/users/src/features/users/commands/register.ts` generates the `usr_` id **before**
calling Cognito `signUp`, instead of letting the nano-id Prisma extension generate it at insert
time:

```ts
const id = generateId(MODEL_ID_PREFIXES.User);
const signUp = await this.auth.signUp(input.email, input.password, id);
```

The id is passed through as `appUserId` and lands in `custom:app_user_id` at sign-up, before the
corresponding Postgres row exists. The same id is then used as the row's own `id` when the row is
created (inside `runAsActor(AuditActor.Register, …)` — see [[audit-fields]]). This ordering makes
`custom:app_user_id` and the Prisma `users.id` the same value from the moment the Cognito user
exists.

## Pre-Token-Generation V2 Lambda (repo's first Lambda)

`infra/modules/cognito/pre-token-lambda/index.mjs` copies `custom:app_user_id` into an
`app_user_id` claim on both the id and access tokens, using the Pre-Token-Generation **V2**
event shape (`claimsAndScopeOverrideDetails`, not the V1 `claimsOverrideDetails`):

```js
export const handler = async (event) => {
  const appUserId = event.request.userAttributes["custom:app_user_id"];
  const claims = appUserId ? { app_user_id: appUserId } : {};
  event.response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: { claimsToAddOrOverride: claims },
      accessTokenGeneration: { claimsToAddOrOverride: claims },
    },
  };
  return event;
};
```

- No DB access, no VPC — the id is read directly from the trigger event's `userAttributes`
  (set by `register` at sign-up), so the function needs no extra IAM policy beyond its bare
  execution role (`aws_iam_role.pre_token`, `sts:AssumeRole` for `lambda.amazonaws.com`).
- Runtime `nodejs20.x`, packaged via `data.archive_file` (zip of the module's `pre-token-lambda/`
  directory), deployed as `aws_lambda_function.pre_token`.
- `aws_lambda_permission.pre_token_cognito` grants `cognito-idp.amazonaws.com` `InvokeFunction`
  on the pool's ARN.
- Verified in earlier POCs (referenced from `2026-07-12-app-user-id-token-claim` plan): V2
  Pre-Token-Generation triggers **do** fire on Floci and custom attributes are readable in the
  event. (Note: PostConfirmation does **not** fire on Floci — a different trigger — see
  [[ADR-0017-floci-local]] consequences.)

## Wiring the trigger — awscli fallback, not native

The pinned AWS provider (`= 5.31.0`, required by [[ADR-0017-floci-local]] for Floci compatibility)
has an `aws_cognito_user_pool.lambda_config` block with **no `pre_token_generation_config`
sub-block** — the V2 trigger cannot be declared natively at that provider version. The trigger is
instead wired by `infra/modules/cognito/scripts/set-pre-token-trigger.sh`, invoked from
`terraform_data.pre_token_trigger` (`local-exec`, depends on the Lambda permission), following the
same [[awscli-fallback-for-floci]] pattern already used for the Cognito App Client on Floci
(`create-user-pool-client.sh`).

The script matters because `UpdateUserPool` is a **PUT**, not a PATCH: a call passing only
`--lambda-config` would silently reset every other top-level pool setting (password `Policies`,
`AutoVerifiedAttributes`, `AdminCreateUserConfig`, etc.) to service defaults — re-tightening the
intentionally relaxed local password policy. `set-pre-token-trigger.sh` is therefore
**settings-preserving**:

1. `describe-user-pool` reads the current pool.
2. It keeps every field `update-user-pool` accepts (`Policies`, `VerificationMessageTemplate`,
   `UserAttributeUpdateSettings`, `DeviceConfiguration`, `EmailConfiguration`, `SmsConfiguration`,
   `UserPoolTags`, `AdminCreateUserConfig`, `UserPoolAddOns`, `AccountRecoverySetting`,
   `DeletionProtection`, `MfaConfiguration`, `SmsAuthenticationMessage`,
   `AutoVerifiedAttributes`), and injects the new `LambdaConfig.PreTokenGenerationConfig`
   (`{"LambdaVersion": "V2_0", "LambdaArn": <arn>}`).
3. Re-applies the whole `update-user-pool` call with the merged settings.
4. Verifies the trigger landed by re-reading the pool and comparing the resulting
   `LambdaConfig.PreTokenGenerationConfig.LambdaArn` to the expected ARN — failing loudly if not.

Schema/custom attributes are **not** re-passed by the script (they are create-only via
`add-custom-attributes`, never part of `update-user-pool`), so `custom:app_user_id` is untouched
by this wiring step.

## Related

- [[ADR-0010-cognito-auth]] — Cognito as the identity provider; this spec extends it with a
  custom claim, not a new decision.
- [[ADR-0017-floci-local]] — the provider pin and Floci trigger-firing quirks this design works
  around.
- [[ADR-0016-local-apigw-nginx-ecs]] — the local reverse proxy that injects `x-user-id` from the
  `sub`; identity resolution is unaffected by `app_user_id`.
- [[awscli-fallback-for-floci]] — the general pattern this Lambda-trigger wiring follows.
- [[terraform-modules]] — module inventory (`infra/modules/cognito`).
- [[aws-resources]] — Cognito resource catalogue.
- [[2026-07-12-app-user-id-token-claim-design]] — original superpowers design this spec is
  normalized from.
- [[users-service-design]] — Users service, where `register` sets the attribute.
- [[nano-id]] — the `usr_`-prefixed id format stored in `custom:app_user_id`.
