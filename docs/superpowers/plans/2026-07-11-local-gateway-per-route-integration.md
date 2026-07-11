# Local Gateway Per-Route Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local API Gateway forward each route's path to nginx (fixing 404s) by creating one HTTP_PROXY integration per route with the path baked into the URI — a Floci-only workaround — while keeping prod on a single shared integration, and write the reachable gateway URL into `.env`.

**Architecture:** The `api-gateway` module becomes data-driven (`local.routes` map + `for_each`) with a `local_gateway` bool flag. When true → per-route integrations with `nginx_base_uri + path`; when false (prod) → the existing single shared integration. `make env-file` gains an `API_GATEWAY_URL` line built from the `api_id` output.

**Tech Stack:** Terraform (AWS provider pinned 5.31.0), Floci local emulator, Make, bash.

## Global Constraints

- **Terraform:** run from `infra/environments/local/` via `terraform -chdir` (Makefile uses `TF := terraform -chdir=infra/environments/local`). Module dir: `infra/modules/api-gateway/`.
- **Floci limit:** a SECOND `terraform apply` fails (`UpdateTags`). Validate structural changes via **teardown + rebuild** (`make bootstrap`), never a re-apply on existing state.
- **AWS provider stays pinned `= 5.31.0`** (ADR-0016 constraint).
- **Prod is unaffected:** `local_gateway` defaults to `false` → single shared integration, current behavior.
- **`nginx-stable`** is the stable Docker-DNS alias the baked URIs resolve to; it is attached by `bootstrap.sh` step 2 (unchanged).
- **Local reachable invoke URL form:** `http://localhost:4566/restapis/<api-id>/$default/_user_request_/<path>` (LocalStack-style; NOT `<id>.execute-api.localhost`).
- **`terraform fmt`** must pass on any changed `.tf`.
- **Git:** `infra-impl` writes only Terraform/config, never runs git/Linear. The main session commits.
- **Language:** config/comments in English; converse in Spanish.

---

### Task 1: Refactor the module to data-driven routes + `local_gateway`

**Files:**
- Modify: `infra/modules/api-gateway/main.tf`
- Modify: `infra/modules/api-gateway/variables.tf`
- Modify: `infra/modules/api-gateway/outputs.tf`

**Interfaces:**
- Consumes: existing `var.context`, `var.cognito_issuer`, `var.cognito_audience`, `var.enable_e2e_cleanup_route`, `var.nginx_integration_uri`.
- Produces: new `var.local_gateway` (bool), `var.nginx_base_uri` (string); outputs `api_id` (existing), `invoke_url` (existing); `integration_id` output REMOVED.

- [ ] **Step 1: Add the two new variables**

In `infra/modules/api-gateway/variables.tf`, append:
```hcl
variable "local_gateway" {
  type        = bool
  default     = false
  description = "Local-only: Floci drops the request path in HTTP_PROXY integrations, so create one integration per route with the path baked into the URI. Prod (real AWS) preserves the path with a single shared integration."
}

variable "nginx_base_uri" {
  type        = string
  default     = "http://nginx-stable"
  description = "Local per-route mode base URI: scheme + host, NO trailing slash and NO path. The module appends each route's path (Floci won't forward it). Ignored when local_gateway = false."
}
```

- [ ] **Step 2: Replace the integration + route resources with the data-driven form**

In `infra/modules/api-gateway/main.tf`, replace everything from the `# ─── nginx HTTP_PROXY Integration ───` comment block through the end of the file (the `nginx` integration and all six route resources: `register`, `login`, `health`, `get_me`, `patch_me`, `e2e_cleanup`) with:

```hcl
# ─── Route table (single source of truth) ────────────────────────────────────
#
# Floci drops the request path in HTTP_PROXY integrations (verified: it parses
# IntegrationUri as a literal URL and ignores $request.path / {proxy}). So in
# local mode we create ONE integration per route with the path baked into the
# URI. Real AWS preserves the path, so prod keeps a single shared integration.
locals {
  routes = merge(
    {
      register = { key = "POST /v1/users/register", path = "/v1/users/register", auth = false }
      login    = { key = "POST /v1/users/login", path = "/v1/users/login", auth = false }
      health   = { key = "GET /v1/health", path = "/v1/health", auth = false }
      get_me   = { key = "GET /v1/users/me", path = "/v1/users/me", auth = true }
      patch_me = { key = "PATCH /v1/users/me", path = "/v1/users/me", auth = true }
    },
    var.enable_e2e_cleanup_route ? {
      e2e_cleanup = { key = "DELETE /v1/users/e2e-cleanup", path = "/v1/users/e2e-cleanup", auth = false }
    } : {}
  )
}

# ─── Integrations ─────────────────────────────────────────────────────────────

# LOCAL: one HTTP_PROXY integration per route, path baked into the URI.
resource "aws_apigatewayv2_integration" "per_route" {
  for_each = var.local_gateway ? local.routes : {}

  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  integration_uri        = "${var.nginx_base_uri}${each.value.path}"
  payload_format_version = "1.0"
}

# PROD: single shared HTTP_PROXY integration (real AWS preserves the path).
resource "aws_apigatewayv2_integration" "shared" {
  count = var.local_gateway ? 0 : 1

  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  integration_uri        = var.nginx_integration_uri
  payload_format_version = "1.0"
}

# ─── Routes ───────────────────────────────────────────────────────────────────
resource "aws_apigatewayv2_route" "this" {
  for_each = local.routes

  api_id    = aws_apigatewayv2_api.this.id
  route_key = each.value.key
  target = var.local_gateway ? (
    "integrations/${aws_apigatewayv2_integration.per_route[each.key].id}"
    ) : (
    "integrations/${aws_apigatewayv2_integration.shared[0].id}"
  )

  authorization_type = each.value.auth ? "JWT" : "NONE"
  authorizer_id      = each.value.auth ? aws_apigatewayv2_authorizer.jwt.id : null
}
```

Leave the `aws_apigatewayv2_api`, `aws_apigatewayv2_stage`, and `aws_apigatewayv2_authorizer` resources at the top of the file unchanged.

- [ ] **Step 3: Remove the dead `integration_id` output**

In `infra/modules/api-gateway/outputs.tf`, DELETE the entire `output "integration_id"` block (it referenced `aws_apigatewayv2_integration.nginx.id`, which no longer exists, and nothing consumes it — confirmed: no reference in `environments/local`). Keep `output "api_id"` and `output "invoke_url"` as-is.

- [ ] **Step 4: Format and validate the module**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
terraform -chdir=infra/modules/api-gateway fmt
terraform -chdir=infra/environments/local validate
```
Expected: `fmt` reports the file(s) it formatted (or nothing); `validate` prints `Success! The configuration is valid.` If validate complains about `integration_id` still being referenced, grep for the reference and remove it. Do NOT run `apply` here.

- [ ] **Step 5: Commit** *(main session — infra-impl leaves work in the tree)*

---

### Task 2: Wire `local_gateway` in the local environment + expose `api_id`

**Files:**
- Modify: `infra/environments/local/main.tf`
- Modify: `infra/environments/local/outputs.tf`

**Interfaces:**
- Consumes: the module's new `local_gateway`, `nginx_base_uri` inputs and its `api_id` output.
- Produces: an `api_id` output at the environment level (for `make env-file`).

- [ ] **Step 1: Pass the local-mode inputs to the module**

In `infra/environments/local/main.tf`, in the `module "api_gateway"` block, add `local_gateway = true` and `nginx_base_uri = "http://nginx-stable"`, and keep `nginx_integration_uri` (now unused in local mode but harmless — leave it to avoid churn, OR remove it; the module var has no default so it must still be provided unless you give it a default). To keep it simple: give `nginx_integration_uri` a default in the module and drop it from the local call.

Concretely — in `infra/modules/api-gateway/variables.tf`, ensure `nginx_integration_uri` has a default:
```hcl
variable "nginx_integration_uri" {
  type        = string
  default     = "http://0.0.0.0:80/"
  description = "Prod single-integration URI. Used only when local_gateway = false."
}
```
Then the local module call becomes:
```hcl
module "api_gateway" {
  source                   = "../../modules/api-gateway"
  context                  = { id = module.label_api.id, tags = module.label_api.tags }
  cognito_issuer           = module.cognito.issuer
  cognito_audience         = module.cognito.client_id
  local_gateway            = true
  nginx_base_uri           = "http://nginx-stable"
  enable_e2e_cleanup_route = true
}
```

- [ ] **Step 2: Expose `api_id` at the environment level**

In `infra/environments/local/outputs.tf`, add:
```hcl
output "api_id" {
  description = "HTTP API Gateway id. Used by `make env-file` to build the reachable local invoke URL."
  value       = module.api_gateway.api_id
}
```
Leave the existing `api_invoke_url` output unchanged.

- [ ] **Step 3: Validate**

Run:
```bash
terraform -chdir=infra/environments/local fmt
terraform -chdir=infra/environments/local validate
```
Expected: `Success! The configuration is valid.`

- [ ] **Step 4: Commit** *(main session)*

---

### Task 3: `make env-file` writes `API_GATEWAY_URL`

**Files:**
- Modify: `Makefile` (the `env-file` target)

**Interfaces:**
- Consumes: `terraform output -raw api_id` (from Task 2).
- Produces: an `API_GATEWAY_URL` line inside the AUTO-GENERATED box in `.env`.

- [ ] **Step 1: Add api_id fetch + the URL line inside the AUTO-GENERATED box**

In the `env-file` target of `Makefile`, add an `api_id` fetch next to the existing `pool`/`client` fetches, and print an `API_GATEWAY_URL` line inside the generated box. The reachable URL is LocalStack-style built from the api-id. Because the box is printed via `printf` in a `make`/shell recipe, the literal `$default` in the URL must be escaped so neither Make nor the shell expands it: use `$$default` in the recipe (Make → `$default` to the shell; single-quote the shell portion so the shell does not treat `$default` as a variable — or escape as needed). Concretely:

Add after the `client=...` line:
```make
	apiid="$$($(TF) output -raw api_id)"; \
```
Add inside the printf box (after the `COGNITO_CLIENT_ID` line, before the END marker):
```make
		printf 'API_GATEWAY_URL=http://localhost:4566/restapis/%s/$$default/_user_request_\n' "$$apiid"; \
```
Here `$$default` becomes the literal `$default` in the written file (Make collapses `$$`→`$`; it is inside a single-quoted printf format so the shell does not expand it). Verify the written line contains a literal `$default`, not an empty string.

- [ ] **Step 2: Update the target's doc comment**

Update the `## Refresh Cognito IDs...` help text and the leading `@#` comment to mention it also writes `API_GATEWAY_URL`. Keep it brief.

- [ ] **Step 3: Static check the Makefile change (no apply yet)**

Run:
```bash
make -n env-file 2>&1 | head -20
```
Expected: dry-run prints the recipe without error (it won't have live terraform outputs in `-n`, that's fine — this only checks the recipe parses). Confirm the `API_GATEWAY_URL=...$default...` line is present in the printed recipe.

- [ ] **Step 4: Commit** *(main session)*

---

### Task 4: Simplify bootstrap docs (remove obsolete integration-patch references)

**Files:**
- Modify: `infra/environments/local/bootstrap.sh` (comments/docs only)
- Modify: `infra/modules/api-gateway/main.tf` (only if a stale `nginx_integration_uri` bootstrap comment remains)

**Interfaces:** none (documentation only — bootstrap already relies on the `nginx-stable` alias and does not patch the integration).

- [ ] **Step 1: Confirm bootstrap does not patch integrations**

Run:
```bash
grep -nE "update-integration|integration_id|integration-uri" infra/environments/local/bootstrap.sh || echo "no integration patching in bootstrap"
```
Expected: `no integration patching in bootstrap` (confirmed earlier). If any reference exists, remove that block — Terraform now owns the URIs.

- [ ] **Step 2: Update stale comments that describe IP patching**

In `infra/environments/local/main.tf`, the comment above the module call (around the `nginx_integration_uri`/JE-36 note) and any `# integration_uri is a placeholder ... bootstrap patches it` comment in the module's `main.tf` are now inaccurate. Update them to state: local mode bakes each route's path into per-route integration URIs at apply time using the stable `nginx-stable` alias; no post-apply patch. Keep edits to comments only.

- [ ] **Step 3: Commit** *(main session)*

---

### Task 5: End-to-end verification via teardown + rebuild

**Files:** none (verification only).

> This task requires a full local rebuild (Floci forbids a second apply). It resets Cognito/DB IDs and regenerates `.env`. Run it as one deliberate step.

- [ ] **Step 1: Rebuild the stack from scratch**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
make bootstrap
```
Expected: Floci up → `terraform apply` succeeds (per-route integrations created) → `.env` refreshed → users built/started → `bootstrap.sh` OK (DB user + `nginx-stable` alias). If apply fails on `UpdateTags`, run `make clean` first (tears down), then `make bootstrap` again.

- [ ] **Step 2: Confirm `.env` has the gateway URL**

Run:
```bash
grep -E "API_GATEWAY_URL|COGNITO_" .env
```
Expected: an `API_GATEWAY_URL=http://localhost:4566/restapis/<api-id>/$default/_user_request_` line (literal `$default`, real api-id), plus the Cognito box. Also confirm the manual `APIDOG_*` lines are still present (preserved outside the box).

- [ ] **Step 3: Health + public POST through the gateway**

Run (substitute the api-id from `.env`, or derive it):
```bash
API_ID=$(terraform -chdir=infra/environments/local output -raw api_id)
BASE="http://localhost:4566/restapis/$API_ID/\$default/_user_request_"
curl -s -o /dev/null -w "health: %{http_code}\n" "$BASE/v1/health"
curl -s -o /dev/null -w "register-valid: %{http_code}\n" -X POST "$BASE/v1/users/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"gw@example.co","password":"P@ssw0rd!","fullName":"GW"}'
curl -s -o /dev/null -w "register-invalid: %{http_code}\n" -X POST "$BASE/v1/users/register" \
  -H "Content-Type: application/json" -d '{"email":"x@y.co"}'
```
Expected: `health: 200`, `register-valid: 201`, `register-invalid: 400` (Zod validation through the full chain).

- [ ] **Step 4: Protected route enforces the JWT authorizer**

Run:
```bash
curl -s -o /dev/null -w "me-no-jwt: %{http_code}\n" "$BASE/v1/users/me"
```
Expected: `me-no-jwt: 401` — proves the Cognito authorizer is still active on `GET /v1/users/me` (the prod-like contract survives). A `200` or `404` here means auth was dropped — investigate before claiming done.

- [ ] **Step 5: Confirm nginx received the real paths**

Run:
```bash
NGINX=$(docker ps --format '{{.Names}}' | grep -iE "floci-ecs.*nginx" | head -1)
docker logs "$NGINX" 2>&1 | tail -6
```
Expected: log lines show `GET /v1/health`, `POST /v1/users/register` (real paths), NOT `GET /`.

- [ ] **Step 6: (optional) Point the Apidog spec server at the gateway**

Not required for this plan, but note: `services/users/openapi.yaml`'s `server` is `http://localhost:3000` (direct). The gateway-routed base is now in `.env` as `API_GATEWAY_URL`. Updating the spec's server is a follow-up if gateway-routed Apidog testing is wanted (see the mcp-servers runbook).

---

## Self-Review

**Spec coverage:**
- Per-route integrations with baked path (local) → Task 1. ✓
- `local_gateway` flag, prod unchanged → Task 1 (default false) + Task 2. ✓
- Data-driven `for_each` routes, preserve e2e gating + JWT auth → Task 1 `local.routes` (merge with `enable_e2e_cleanup_route`; `auth` per route). ✓
- Terraform owns URIs, no bootstrap patch → Task 4. ✓
- `make env-file` writes reachable gateway URL from `api_id` → Task 3 (+ Task 2 exposes `api_id`). ✓
- End-to-end validation incl. JWT 401 → Task 5. ✓
- Preserve `APIDOG_*` in `.env` → Task 5 Step 2 assertion (the box mechanism already preserves out-of-box lines). ✓

**Placeholder scan:** No TBD/TODO. `<api-id>`/`<path>` are URL templates, not gaps.

**Type consistency:** `local.routes` entries use `{key, path, auth}` consistently in Task 1's integration + route resources. Env-level `api_id` output (Task 2) matches the `terraform output -raw api_id` consumed in Task 3 and Task 5. The `$default`/`$$default` escaping is called out explicitly in Task 3 to avoid a silently-empty URL.

**Known risk:** Task 5 depends on a clean Floci rebuild; if `make bootstrap` hits the second-apply `UpdateTags` bug, `make clean` then retry (noted in Task 5 Step 1).

## Related

- [[2026-07-11-local-gateway-per-route-integration-design]]
- [[ADR-0016-local-apigw-nginx-ecs]]
- [[mcp-servers]]
