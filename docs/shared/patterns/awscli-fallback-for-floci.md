---
title: "awscli fallback for Floci gaps"
type: pattern
area: infra
status: active
created: 2026-07-12
updated: 2026-07-12
tags:
  - type/pattern
  - area/infra
  - status/active
related:
  - "[[ADR-0017-floci-local]]"
  - "[[terraform-modules]]"
  - "[[cognito-pre-token-lambda]]"
---

# awscli fallback for Floci gaps

## Pattern

When a native Terraform resource cannot be applied against **Floci** (local AWS emulator,
[[ADR-0017-floci-local]]) — or the AWS provider pin required for Floci compatibility (`= 5.31.0`)
lacks a block a feature needs — wire the missing piece with `terraform_data` + a `local-exec`
provisioner calling an **idempotent AWS CLI script**, outside Terraform's managed resource
lifecycle, instead of forcing the native resource or bumping the provider.

```hcl
resource "terraform_data" "some_fallback" {
  input = { ... }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/some-fallback.sh"
    interpreter = ["/usr/bin/env", "bash"]
    environment = { ... }
  }
}
```

## When to use it

**Only when the native resource is impossible against Floci — never by preference.** The pattern
trades away Terraform state tracking for the target resource, so it is a last resort, not a
default style. Two real, verified cases in this repo:

1. **`create-user-pool-client.sh`** (`infra/modules/cognito/scripts/`) — the native
   `aws_cognito_user_pool_client` resource **aborts the apply** on Floci: Floci's CREATE response
   returns an empty `AnalyticsConfiguration` (and `RefreshTokenRotation`) struct, and the AWS
   provider's SDKv2 post-apply consistency check reads that as "block count changed from 0 to 1"
   and fails. This happens **before** any plan-diff is computed, so `lifecycle.ignore_changes`
   — which only suppresses diffs between two plans, not the provider's internal
   Create-response validation — cannot prevent it. Verified empirically (see the `floci` skill,
   quirk #2, and [[ADR-0017-floci-local]]).
2. **`set-pre-token-trigger.sh`** (`infra/modules/cognito/scripts/`) — the pinned AWS provider
   (`= 5.31.0`, required for Floci) has no `pre_token_generation_config` sub-block on
   `aws_cognito_user_pool.lambda_config`, so a Pre-Token-Generation **V2** trigger cannot be
   declared natively at that provider version. See [[cognito-pre-token-lambda]] for the full
   Lambda + trigger design this script wires.

Do not reach for this pattern to work around ordinary Terraform friction, a provider version you
simply haven't upgraded, or a resource that Floci actually supports — try the native resource
first, and only fall back when it demonstrably cannot apply (as both cases above proved through
direct `terraform apply` failures, not speculation).

## Making the script idempotent and settings-preserving

- **Idempotent lookup before create.** `create-user-pool-client.sh` lists existing clients by
  name before creating one, and reuses the existing client id on re-apply instead of creating
  duplicates.
- **Settings-preserving updates.** When the underlying AWS API is a full-resource **PUT** rather
  than a partial PATCH — Cognito's `UpdateUserPool` is the concrete example — a naive call that
  passes only the new field would silently reset every other top-level setting to service
  defaults. `set-pre-token-trigger.sh` first `describe-user-pool`s the current state, keeps every
  field `update-user-pool` accepts, injects only the new value, and re-applies the merged whole.
  Fields the update API does not accept (e.g. Cognito schema/custom attributes, which are
  create-only) are deliberately left untouched.
- **Independent verification.** Both scripts confirm the change actually landed by re-reading the
  resource afterward and comparing against the expected value, rather than trusting the AWS CLI
  call's exit code alone — `set-pre-token-trigger.sh` re-reads `LambdaConfig` and fails loudly if
  the ARN doesn't match.
- **State handoff back to Terraform.** Where a downstream `output` needs the created resource's id
  (e.g. the Cognito client id), the script writes a small JSON file to a state path under the
  **root** module's working directory (`var.local_state_dir`, not `path.module` — module source
  may be read-only), which a paired `data.local_file` resource reads back into Terraform.

## Trade-offs

- **Outside Terraform's lifecycle: not in state.** The resource the script manages (the Cognito
  client, the Lambda trigger wiring) is not tracked by `terraform state` — Terraform only tracks
  the `terraform_data` wrapper and its `local-exec` invocation, not the underlying AWS resource's
  attributes. `terraform plan` cannot diff drift on it the way it would a native resource.
  Idempotency and drift-correction are entirely the script's responsibility, not Terraform's.
- **Must be re-runnable.** Because Terraform will re-run the `local-exec` provisioner whenever
  `terraform_data.input` changes (or, in the Floci workflow, whenever the stack is torn down and
  rebuilt via `make bootstrap` — see [[ADR-0017-floci-local]]'s known limitation that a second
  `apply` fails on Floci), every fallback script must produce the same end state whether it is
  running for the first time or the tenth.
- **Local-only, not a prod pattern.** Both instances in this repo are gated to the local
  environment (`var.manage_client_via_provider = false`, or unconditionally under
  `environments/local`); production keeps the native Terraform resource wherever the provider and
  target AWS API support it.

## Related

- [[ADR-0017-floci-local]] — the provider pin and emulation gaps this pattern works around.
- [[terraform-modules]] — module inventory; both fallback scripts live under
  `infra/modules/cognito/scripts/`.
- [[cognito-pre-token-lambda]] — the Pre-Token-Generation Lambda spec that uses
  `set-pre-token-trigger.sh`.
