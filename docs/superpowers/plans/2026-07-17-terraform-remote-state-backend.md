# Terraform Remote State Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Terraform state onto a remote S3 + DynamoDB backend (Floci locally, AWS-ready for prod), created once by a dedicated bootstrap root, ending local `.tfstate` drift/churn.

**Architecture:** A `tf-backend` module (versioned S3 bucket + DynamoDB lock table) is applied once by a `environments/local/backend/` root that keeps LOCAL state (self-excluding, solving the chicken-and-egg). Phase-1 (`environments/local`) and phase-2 (`environments/local/post`) then declare an empty `backend "s3" {}` and are `init`'d with a per-environment `backend.hcl` (Floci endpoints), storing state under distinct keys in that bucket. `make bootstrap` gains a `backend-up` step before infra-init.

**Tech Stack:** Terraform (AWS provider pinned `= 5.31.0`), Floci (S3 + DynamoDB at `:4566`), cloudposse/label naming, Make.

## Global Constraints

- **Provider stays pinned `= 5.31.0`** — do NOT bump. Use the `backend "s3"` config form that this Terraform/provider era accepts (the `endpoint`/`dynamodb_endpoint`/`sts_endpoint` keys per `example.hcl`); if `terraform init` rejects a key on the installed version, adapt to the accepted form and note it.
- **The backend root keeps LOCAL state by design** — it is the ONLY root that does. It must NOT declare `backend "s3"`.
- **Distinct state keys, one bucket:** phase-1 → `local/phase1/terraform.tfstate`, phase-2 → `local/phase2/terraform.tfstate`.
- **Do NOT migrate the old `.desync-bak` state** — start fresh. The real roots init into an empty remote backend.
- **Idempotency:** `backend-up` (apply of the backend root) must be a no-op when the bucket/table already exist.
- **Naming:** bucket/table names via the cloudposse/label module, consistent with existing modules.
- **Floci endpoints:** the backend root's provider and the `backend.hcl` point S3/DynamoDB/STS at `http://localhost:4566`, path-style, skip-validation (mirror the existing `providers.tf` + `example.hcl`).
- **No app/service/resource changes** — this is state-plumbing only. The `/v1/products` routing fix already in the working tree is applied by the clean rebuild, not by this plan.
- **Git:** main session commits per task (commit-only, no push); `infra-impl` writes only Terraform/config, never git. Conventional Commits, scope `infra`.

---

### Task 1: `tf-backend` module + `backend/` root (local state); apply live

**Files:**
- Create: `infra/modules/tf-backend/main.tf`, `variables.tf`, `outputs.tf`
- Create: `infra/environments/local/backend/main.tf`, `providers.tf`, `terraform.tf`, `variables.tf`
- Create: `infra/environments/local/backend/.gitignore` (ignore this root's local `terraform.tfstate*`)

**Interfaces:**
- Produces: an S3 bucket (versioned) + DynamoDB lock table in Floci; module outputs `bucket_name`, `lock_table_name` consumed by the `backend.hcl` values in Task 2.

- [ ] **Step 1: Write the `tf-backend` module**

`infra/modules/tf-backend/main.tf`:
- Use the cloudposse/label module (mirror another module, e.g. `infra/modules/rds-aurora` or `infra/modules/networking`, for how `module "label"` is invoked and how names are derived).
- `aws_s3_bucket` for state + `aws_s3_bucket_versioning` (Enabled).
- `aws_dynamodb_table` with `hash_key = "LockID"`, attribute `LockID` type `S`, `billing_mode = "PAY_PER_REQUEST"`.
- `variables.tf`: label inputs (namespace/stage/name/tags) + optional explicit `bucket_name`/`table_name` overrides.
- `outputs.tf`: `bucket_name`, `lock_table_name`.

Keep it minimal — no versioning lifecycle rules, no encryption config beyond defaults (Floci support is limited; prod can extend later).

- [ ] **Step 2: Write the `backend/` root (LOCAL state)**

`infra/environments/local/backend/`:
- `terraform.tf`: `required_version`, `required_providers` aws `= 5.31.0`. **NO `backend "s3"` block** (local state by design).
- `providers.tf`: aws provider with Floci endpoints for `s3`, `dynamodb`, `sts`, `iam` at `http://localhost:4566`, `s3_use_path_style = true`, skip-validation flags — mirror `infra/environments/local/providers.tf`.
- `main.tf`: `module "tf_backend"` invoking the module with the local label inputs (namespace `3mrai`, stage `local`, name e.g. `tfstate`).
- `variables.tf`: any inputs (region default `us-east-1`).
- `.gitignore`: `terraform.tfstate`, `terraform.tfstate.*`, `.terraform/`, `.terraform.lock.hcl` as appropriate (match repo convention — check the existing `environments/local/.gitignore`).

- [ ] **Step 3: fmt + validate**

Run:
```bash
cd infra && terraform fmt -recursive modules/tf-backend environments/local/backend
terraform -chdir=environments/local/backend init
terraform -chdir=environments/local/backend validate
```
Expected: fmt clean; init succeeds (local backend, downloads provider); `Success! The configuration is valid.`

- [ ] **Step 4: Apply live against Floci (creates the bucket + table)**

Prereq: Floci must be up (`docker compose up -d floci`). Then:
```bash
terraform -chdir=infra/environments/local/backend apply -auto-approve
```
Expected: apply creates the S3 bucket + DynamoDB table. Verify:
```bash
AWS_ENDPOINT_URL=http://localhost:4566 aws s3 ls | grep tfstate
AWS_ENDPOINT_URL=http://localhost:4566 aws dynamodb list-tables --region us-east-1
AWS_ENDPOINT_URL=http://localhost:4566 aws s3api get-bucket-versioning --bucket <bucket> --region us-east-1
```
Expected: bucket present, lock table present, versioning `Enabled`. Record the exact bucket + table names (outputs) — Task 2 needs them.

- [ ] **Step 5: Verify idempotency**

Run the apply again:
```bash
terraform -chdir=infra/environments/local/backend apply -auto-approve
```
Expected: `No changes. Your infrastructure matches the configuration.` (or 0 to add/change/destroy). If it errors on existing resources, adjust (e.g. handle bucket-already-owned) and re-verify.

- [ ] **Step 6: Commit** (main session)

Staged: the module + backend root (NOT the local `terraform.tfstate`, which is gitignored).
Message: `feat(infra): tf-backend module + backend root (S3 state bucket + DynamoDB lock)`

---

### Task 2: Wire phase-1 + phase-2 to the S3 backend; backend.hcl; retire example.hcl

**Files:**
- Modify: `infra/environments/local/terraform.tf` (add `backend "s3" {}`)
- Create: `infra/environments/local/backend.hcl` (phase-1 key)
- Modify: `infra/environments/local/post/terraform.tf` (add `backend "s3" {}`)
- Create: `infra/environments/local/post/backend.hcl` (phase-2 key)
- Modify: `infra/environments/local/post/data.tf` (phase-1 remote_state → s3)
- Delete: `example.hcl` (repo root — superseded)
- Modify: `.gitignore` if needed (ensure `.terraform/` etc. ignored; backend.hcl IS committed — it has no secrets, only Floci endpoints)

**Interfaces:**
- Consumes: the bucket + table names from Task 1.

- [ ] **Step 1: Add the partial backend to phase-1**

In `infra/environments/local/terraform.tf`, inside the `terraform { }` block, add:
```hcl
  backend "s3" {}
```
(empty — config comes from `backend.hcl`).

- [ ] **Step 2: Create `infra/environments/local/backend.hcl`**

Using the bucket/table names from Task 1:
```hcl
bucket                      = "<bucket-from-task1>"
key                         = "local/phase1/terraform.tfstate"
region                      = "us-east-1"
dynamodb_table              = "<table-from-task1>"
endpoint                    = "http://localhost:4566"
sts_endpoint                = "http://localhost:4566"
dynamodb_endpoint           = "http://localhost:4566"
skip_credentials_validation = true
skip_metadata_api_check     = true
skip_region_validation      = true
use_path_style              = true
```
NOTE: if `terraform init` on 5.31.0-era rejects any of these keys (e.g. `dynamodb_endpoint`), switch to the form that version accepts (some versions nest S3/DynamoDB/STS endpoints under an `endpoints { }` block inside the backend config). Whatever form works, keep the same values. Document which form was used in the report.

- [ ] **Step 3: Init phase-1 into the S3 backend**

Prereq: Floci up + Task 1 applied (bucket/table exist). Run:
```bash
terraform -chdir=infra/environments/local init -reconfigure -backend-config=backend.hcl
```
Expected: init succeeds; "Successfully configured the backend 's3'". No prompt to migrate old state (old state is gone/`.desync-bak`). `terraform -chdir=infra/environments/local validate` → valid.

- [ ] **Step 4: Repeat for phase-2**

- `infra/environments/local/post/terraform.tf`: add `backend "s3" {}`.
- Create `infra/environments/local/post/backend.hcl` identical to phase-1's but `key = "local/phase2/terraform.tfstate"`.
- In `infra/environments/local/post/data.tf`, change the phase-1 remote_state data source from local to s3:
```hcl
data "terraform_remote_state" "phase1" {
  backend = "s3"
  config = {
    bucket                      = "<bucket-from-task1>"
    key                         = "local/phase1/terraform.tfstate"
    region                      = "us-east-1"
    endpoint                    = "http://localhost:4566"
    dynamodb_endpoint           = "http://localhost:4566"
    sts_endpoint                = "http://localhost:4566"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    use_path_style              = true
  }
}
```
(Use the same endpoint form that worked in Step 2.) Then `terraform -chdir=infra/environments/local/post init -reconfigure -backend-config=backend.hcl && ... validate`.

- [ ] **Step 5: Delete `example.hcl`**

Run: `git rm example.hcl` (superseded by the per-environment `backend.hcl` files).

- [ ] **Step 6: fmt + validate both roots**

Run:
```bash
cd infra && terraform fmt -recursive environments/local
terraform -chdir=environments/local validate
terraform -chdir=environments/local/post validate
```
Expected: fmt clean; both valid.

- [ ] **Step 7: Commit** (main session)

Staged: the two `terraform.tf` edits, both `backend.hcl` files, `post/data.tf`, deleted `example.hcl`.
Message: `feat(infra): store phase-1/phase-2 state in the S3 backend via backend.hcl`

---

### Task 3: `make backend-up` target + wire into bootstrap; init flags

**Files:**
- Modify: `Makefile` (new `backend-up` target; `.PHONY`; `infra-init` + `infra-up-post` pass `-backend-config`; `bootstrap` calls `backend-up`)

**Interfaces:**
- Consumes: the backend root (Task 1), the backend.hcl files (Task 2).

- [ ] **Step 1: Add the `backend-up` target**

In `Makefile`, add (and to `.PHONY`):
```makefile
backend-up: ## Create the remote-state bucket + lock table in Floci (idempotent; local state)
	terraform -chdir=$(TF_LOCAL_DIR)/backend init
	terraform -chdir=$(TF_LOCAL_DIR)/backend apply -auto-approve
```
(Match the existing `TF_LOCAL_DIR` variable; if a `TF_BACKEND_DIR` reads cleaner, define it.)

- [ ] **Step 2: Pass `-backend-config` in `infra-init`**

Change `infra-init`:
```makefile
infra-init: ## terraform init (environments/local) into the S3 backend
	$(TF) init -reconfigure -backend-config=backend.hcl
```
And in `infra-up-post`, ensure the phase-2 init passes `-backend-config=backend.hcl` for the post root (find the phase-2 init line in that target and add the flag; use `-reconfigure`).

- [ ] **Step 3: Insert `backend-up` into `bootstrap`**

In the `bootstrap` target, add `$(MAKE) backend-up` immediately after `$(COMPOSE) up -d floci` and before the infra-init/`infra-up` step. Keep the rest of the order intact.

- [ ] **Step 4: Verify the target in isolation**

Run (Floci up):
```bash
make backend-up
```
Expected: creates or no-ops the bucket/table; exit 0. Run twice — second run is a no-op.

- [ ] **Step 5: Commit** (main session)

Staged: `Makefile`.
Message: `build(infra): make backend-up; bootstrap creates remote state before init`

---

### Task 4: Full clean-slate bootstrap + end-to-end verification

**Files:** none (verification only; may capture nothing to commit).

- [ ] **Step 1: Clean slate**

Run:
```bash
echo "y" | make clean   # destroy (no-op if empty) + compose down + remove ./data
# also clear any stray local state on the real roots (keep the backend root's state)
rm -f infra/environments/local/terraform.tfstate* infra/environments/local/post/terraform.tfstate*
```
NOTE: do NOT remove `infra/environments/local/backend/terraform.tfstate` — that root legitimately keeps local state.

- [ ] **Step 2: Full bootstrap on the new backend**

Run: `make bootstrap` (capture the REAL exit code, not a pipe's — e.g. run without piping to tail, or check `$?`/`$PIPESTATUS`).
Expected: completes end-to-end: floci → backend-up → infra-init (s3) → phase-1 apply → env-file → migrate → users → bootstrap.sh → phase-2 (s3) → services. NO local `.tfstate` written for phase-1/phase-2 (state is in S3).

- [ ] **Step 3: Verify state is in S3, not local files**

Run:
```bash
AWS_ENDPOINT_URL=http://localhost:4566 aws s3 ls s3://<bucket>/local/phase1/ --region us-east-1
AWS_ENDPOINT_URL=http://localhost:4566 aws s3 ls s3://<bucket>/local/phase2/ --region us-east-1
ls infra/environments/local/terraform.tfstate 2>&1 || echo "no local phase-1 state (correct)"
```
Expected: both phase keys present in S3; no local `terraform.tfstate` on the real roots.

- [ ] **Step 4: End-to-end app verification (incl. the /v1/products fix)**

Run:
```bash
GW=$(grep '^API_GATEWAY_URL=' .env | cut -d= -f2-)
curl -s -o /dev/null -w "products no-hdr: %{http_code}\n" "$GW/v1/products"
curl -s -o /dev/null -w "products w/hdr : %{http_code}\n" -H "x-user-id: some-sub" "$GW/v1/products"
curl -s -o /dev/null -w "my-orders w/hdr: %{http_code}\n" -H "x-user-id: some-sub" "$GW/v1/orders/my-orders"
```
Expected: `products no-hdr: 401`, `products w/hdr: 200`, `my-orders w/hdr: 401` (proves the gateway route fix landed via the clean rebuild AND the backend works end-to-end).

- [ ] **Step 5: Record results in the ledger** (no commit unless an artifact was produced).

---

## Self-Review

**Spec coverage:**
- tf-backend module (versioned S3 + DynamoDB lock) → Task 1. ✓
- backend/ root with local state (create-once, self-excluding) → Task 1. ✓
- Partial `backend "s3" {}` + per-env backend.hcl on phase-1 & phase-2, distinct keys → Task 2. ✓
- phase-2 remote_state reads phase-1 from s3 → Task 2 Step 4. ✓
- example.hcl retired → Task 2 Step 5. ✓
- make backend-up first in bootstrap; init flags → Task 3. ✓
- Fresh start (no migration of .desync-bak); end-to-end incl. /v1/products → Task 4. ✓
- Prod deferred → Global Constraints + spec §5 (no prod root created; module/pattern reusable). ✓

**Placeholder scan:** No TBD/"handle edge cases". The `<bucket-from-task1>`/`<table-from-task1>` and "use the endpoint form the pinned version accepts" are explicit carry-forward-a-real-value and verify-then-adapt instructions, not placeholders — the implementer substitutes the actual names/form.

**Type/name consistency:** the state keys (`local/phase1/terraform.tfstate`, `local/phase2/terraform.tfstate`) are identical across Task 2's backend.hcl, post/data.tf, and Task 4's verification. `backend-up` target name consistent across Task 3 (define) and the bootstrap insertion. `tf-backend` module outputs (`bucket_name`, `lock_table_name`) feed Task 2's backend.hcl.

**Risk sequencing:** the backend must exist before any real root inits — Task 1 (create + apply the backend) precedes Task 2 (init roots into it) and Task 3 (bootstrap wiring). The two spec risks (Floci S3 versioning/DynamoDB lock; the `init` backend-config key form on 5.31.0) are hit and resolved inline in Task 1 Step 4 and Task 2 Step 2.

## Related

- [[2026-07-17-terraform-remote-state-backend-design]]
- [[ADR-0017-floci-local]]
- [[floci-rds-apigw-limits]]
