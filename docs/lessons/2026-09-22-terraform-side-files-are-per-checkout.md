---
title: "Terraform side files under infra/environments/local are per-checkout, not per-stack — symlinking them across worktrees fed a stale Cognito client into the authorizer"
type: lesson
area: infra
status: active
created: 2026-09-22
updated: 2026-09-22
tags:
  - type/lesson
  - area/infra
  - status/active
  - severity/high
related:
  - "[[awscli-fallback-for-floci]]"
  - "[[local-dev-floci]]"
  - "[[ADR-0017-floci-local]]"
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
---

# Terraform side files under infra/environments/local are per-checkout, not per-stack — symlinking them across worktrees fed a stale Cognito client into the authorizer

## Finding

`infra/environments/local/` accumulates git-ignored side files written by the
[[awscli-fallback-for-floci]] provisioning scripts, outside Terraform's own state:

- `.terraform-cognito/<id>-client.json` — `ClientId`, `UserPoolId`
- `.terraform-docdb/<cluster>.json`
- `.terraform-redis/<group>.json`

A `data.local_file` (Terraform data source) reads each of these at plan time, and the values
flow forward into real resources — the Cognito `ClientId` becomes both the API Gateway JWT
authorizer's `audience` and the `cognito_client_id` output that `make env-file` writes into
every service's env file.

These files describe the **live** Floci resources of whichever checkout most recently
provisioned them. They are per-checkout, not a durable description of "the stack": a fresh git
worktree has none, and `terraform plan` fails immediately with a "Read local file data source
error" until they exist.

## What went wrong

In a worktree, symlinking these directories back to the main checkout — reaching for a shortcut
to avoid re-provisioning — pulled in a **stale** client JSON left over from a previous Floci
lifetime (client `1119…`, pool `us-east-1_1af18140e`). `make infra-up` then applied that stale
id as the authorizer's `audience`, and `make env-file` propagated it into every env file.

Symptom: every JWT-authorized gateway route answered `401 {"message":"Unauthorized"}`, even with
a token freshly issued by the CURRENT live Cognito pool. Unauthenticated routes kept working
normally, which is what pointed at the authorizer rather than the gateway wiring or nginx.

Diagnosis in one step: compare the token's `client_id` claim against the authorizer's
`Audience`:

```bash
aws apigatewayv2 get-authorizers --api-id <id> --endpoint-url http://localhost:4566
```

A mismatch there — old id in `Audience`, new id in the token — is conclusive; no further
probing of nginx, the gateway route map, or the service itself is needed once the two ids are
side by side.

### Fix applied

1. Regenerate the side file by running the provisioning script directly against the live pool —
   `infra/modules/cognito/scripts/create_user_pool_client.py` is idempotent: it lists the pool's
   clients first, and if one named `<context-id>-client` already exists it **reuses** that client
   (reconciling its auth flows) and rewrites the side file, only creating a new client when none
   with that name exists yet:
   ```bash
   aws cognito-idp list-user-pools --max-results 10 --endpoint-url http://localhost:4566

   USER_POOL_ID=<live-pool-id> CLIENT_NAME=3mrai-local-cognito-client \
   STATE_FILE="$PWD/infra/environments/local/.terraform-cognito/3mrai-local-cognito-client.json" \
   ENDPOINT_URL=http://localhost:4566 AWS_REGION=us-east-1 \
   AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test EXECUTION_LOG_TABLE= \
   .venv/bin/python infra/modules/cognito/scripts/create_user_pool_client.py
   ```
   It printed `reused existing client '3mrai-local-cognito-client' (4116f6ee…)` — same client id,
   corrected side file. Terraform itself never re-runs this script on its own: it fires once via a
   `terraform_data` + `local-exec` provisioner at resource creation, which is why a plain
   `terraform plan`/`apply` in a new checkout never produces the side file on its own.
2. Targeted `terraform apply` of just the authorizer resource, so it picks up the corrected
   `audience`.
3. `make env-file` to re-propagate the corrected `cognito_client_id` into every env file.

## A related gotcha in the same session — nginx bind-mount is also checkout-absolute

The nginx ECS task definition bind-mounts `nginx.conf` from `abspath(path.module)/nginx` — the
**absolute path of the checkout that ran `apply`**. Applying from a worktree repoints the live
nginx task at that worktree's path. If the worktree is later deleted, the task definition is
left pointing at a path that no longer exists (observed directly: the live state already
pointed at a deleted Orca workspace path).

Every `apply` also re-creates the nginx ECS service/task as a side effect of Floci's own drift
behavior on that resource, so after any apply that touches nginx, re-run `bootstrap.py`'s nginx
alias step to bring the task definition back in line with the current checkout.

## Rule

**Do not symlink or blindly copy `.terraform-*` side files between checkouts.** Before applying
from a new checkout (including a fresh worktree), create the Cognito side file by running the
provisioning script directly against the live pool, from the checkout root:

```bash
aws --endpoint-url http://localhost:4566 cognito-idp list-user-pools --max-results 10

USER_POOL_ID=<pool id> CLIENT_NAME=3mrai-local-cognito-client \
STATE_FILE="$PWD/infra/environments/local/.terraform-cognito/3mrai-local-cognito-client.json" \
ENDPOINT_URL=http://localhost:4566 AWS_REGION=us-east-1 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test EXECUTION_LOG_TABLE= \
.venv/bin/python infra/modules/cognito/scripts/create_user_pool_client.py
```

The script is idempotent — it reuses the existing `3mrai-local-cognito-client` client by name
rather than minting a new one, so this is safe to run repeatedly and is the **recommended** way
to produce the side file in a new checkout. Hand-writing the JSON from ids read via the AWS CLI
works too, but is the fallback when the script itself is unavailable, not the primary method.
The DocDB/Redis side files under `.terraform-docdb/` and `.terraform-redis/` have no equivalent
script yet, so they still require hand-writing from live ids per [[awscli-fallback-for-floci]].

## Related

- [[awscli-fallback-for-floci]] — the provisioning scripts (`create-user-pool-client.sh`, DocDB/
  Redis equivalents) that write these side files and the `data.local_file` handoff pattern that
  reads them back into Terraform.
- [[local-dev-floci]] — the `make bootstrap` flow whose `infra-up` step applies against these
  side files and whose `env-file` step propagates their values into every service.
- [[ADR-0017-floci-local]] — the Floci decision and its known re-apply/state quirks this finding
  extends.
- [[ADR-0016-local-apigw-nginx-ecs]] — the local API Gateway → nginx → service topology whose
  authorizer `audience` and nginx bind-mount were both affected here.
