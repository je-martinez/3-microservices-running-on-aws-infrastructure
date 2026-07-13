---
title: Local API Gateway path fix — per-route integrations (Floci)
type: spec
area: infra
status: draft
created: 2026-07-11
updated: 2026-07-11
tags:
  - type/spec
  - area/infra
  - status/draft
related:
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
  - "[[ADR-0009-apigw-alb-fargate]]"
  - "[[mcp-servers]]"
---

# Local API Gateway path fix — per-route integrations (Floci)

## Problem

The local topology (per [[ADR-0016-local-apigw-nginx-ecs]]) is prod-like:

```
API Gateway v2 (+ Cognito JWT authorizer) → nginx ECS (nginx-stable) → users:3000
```

But hitting a route through the local gateway 404s: nginx receives `GET /`
instead of `GET /v1/health`. **The request path is lost at the API Gateway →
nginx hop.**

Root cause (confirmed live against the running Floci, via its
`io.git.hec.flo.ser.api.pro.HttpProxyInvoker` logs): Floci treats an
`HTTP_PROXY` integration's `IntegrationUri` as a **literal URL** parsed by
Java's `new URI(...)`. It:

- ignores `RequestParameters` path overwrites (`overwrite:path=$request.path`);
- rejects any templating in the URI — `$request.path` → `unsupported URI`,
  `${request.path.proxy}` / `{proxy}` → `Illegal character in path at index 21`;
- does not forward the matched route path.

So a single shared integration always hits the target's root. This is a **Floci
emulator limitation**, NOT a config error: the same single-integration
Terraform is correct on real AWS (which preserves the request path). Real AWS is
governed by [[ADR-0009-apigw-alb-fargate]] and is unaffected.

## Verified solution

Floci **does** honor a path that is baked into the `IntegrationUri`. Verified
end-to-end against the running stack:

- `IntegrationUri = http://nginx-stable/v1/health` → `GET` through the gateway
  returns **200 `{"status":"ok"}`**; nginx logs `GET /v1/health`.
- A dedicated integration for `POST /v1/users/register` with
  `http://nginx-stable/v1/users/register` → **201**, created a real user
  (`usr_…`) with Zod body validation and Postgres persistence; nginx logs
  `POST /v1/users/register`.

API Gateway v2 allows a distinct integration per route, so the fix is: in the
**local** environment, create one `HTTP_PROXY` integration per route with that
route's path baked into the URI. Topology is unchanged and still prod-like; only
the number of integrations differs (N local vs 1 prod).

## Goals

- Local gateway forwards every route's path correctly (no 404s), keeping the
  Cognito JWT authorizer active on protected routes.
- Prod topology/behavior unchanged (single shared integration).
- Terraform is the source of truth for the integration URIs (no post-apply
  `update-integration` patching).
- `make env-file` writes the reachable local gateway URL into `.env`, the same
  way it already writes the Cognito IDs.

## Non-goals (YAGNI)

- No ALB locally (Floci ELBv2 `ip` targets unconfirmed — separate investigation;
  nginx stays per [[ADR-0016-local-apigw-nginx-ecs]]).
- No change to production (`local_gateway` defaults to false).
- No new services or routes beyond the six that exist today.

## Design

### 1. Module `api-gateway` — data-driven routes + `local_gateway` flag

A `local.routes` map is the single source for route key, path, and auth:

```hcl
locals {
  routes = {
    register    = { key = "POST /v1/users/register",     path = "/v1/users/register",    auth = false }
    login       = { key = "POST /v1/users/login",        path = "/v1/users/login",       auth = false }
    health      = { key = "GET /v1/health",              path = "/v1/health",            auth = false }
    get_me      = { key = "GET /v1/users/me",            path = "/v1/users/me",          auth = true  }
    patch_me    = { key = "PATCH /v1/users/me",          path = "/v1/users/me",          auth = true  }
    e2e_cleanup = { key = "DELETE /v1/users/e2e-cleanup", path = "/v1/users/e2e-cleanup", auth = false }
  }
}
```

New variable:

```hcl
variable "local_gateway" {
  type        = bool
  default     = false
  description = "Local-only: Floci drops the request path in HTTP_PROXY, so create one integration per route with the path baked into the URI. Prod (real AWS) preserves the path with a single shared integration."
}
```

Integrations — conditional, both modes present:

```hcl
resource "aws_apigatewayv2_integration" "per_route" {
  for_each               = var.local_gateway ? local.routes : {}
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  integration_uri        = "${var.nginx_base_uri}${each.value.path}"
  payload_format_version = "1.0"
}

resource "aws_apigatewayv2_integration" "shared" {
  count                  = var.local_gateway ? 0 : 1
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  integration_uri        = var.nginx_integration_uri
  payload_format_version = "1.0"
}
```

Routes — `for_each`, targeting the right integration and carrying auth:

```hcl
resource "aws_apigatewayv2_route" "this" {
  for_each  = local.routes
  api_id    = aws_apigatewayv2_api.this.id
  route_key = each.value.key
  target = var.local_gateway
    ? "integrations/${aws_apigatewayv2_integration.per_route[each.key].id}"
    : "integrations/${aws_apigatewayv2_integration.shared[0].id}"
  authorization_type = each.value.auth ? "JWT" : "NONE"
  authorizer_id      = each.value.auth ? aws_apigatewayv2_authorizer.jwt.id : null
}
```

This replaces the six hardcoded route blocks and the single `nginx` integration.

### 2. Variables — base URI vs full URI

```hcl
variable "nginx_base_uri" {
  type        = string
  default     = "http://nginx-stable"   # scheme + host, NO trailing slash, NO path
  description = "Local per-route mode: base host; the module appends each route's path. Ignored when local_gateway = false."
}

# existing, prod only now:
variable "nginx_integration_uri" {
  type        = string
  description = "Prod single-integration URI. Used only when local_gateway = false."
}
```

`infra/environments/local/main.tf` passes `local_gateway = true` and
`nginx_base_uri = "http://nginx-stable"`. Prod omits both → single integration,
current behavior.

### 3. Bootstrap — drop the integration patch

`bootstrap.sh` keeps Step 1 (least-privilege DB user) and Step 2 (attach the
`nginx-stable` Docker alias — still required; it is the host the baked URIs
resolve to). Any `update-integration` patching of the integration URI is
removed: Terraform now creates complete URIs at apply time. (The current
bootstrap already relies on the alias rather than patching an IP, so this is
mostly removing now-obsolete comments/outputs — the implementer confirms what
still references `integration_id` before deleting the output.)

### 4. `make env-file` — write the reachable gateway URL

The local reachable invoke URL is LocalStack-style and depends on the api-id
(which Floci re-mints each apply), so it must be regenerated like the Cognito
IDs. Add, inside the existing AUTO-GENERATED box:

```
API_GATEWAY_URL=http://localhost:4566/restapis/<api_id>/$default/_user_request_
```

built from `terraform output -raw api_id` (module already outputs `api_id`).
The module's `invoke_url`/`api_invoke_url` output is the canonical AWS-format
URL (`https://<id>.execute-api…amazonaws.com/`), which is NOT reachable in
Floci — so `env-file` constructs the reachable form from `api_id`, it does not
use `invoke_url`. The box already preserves out-of-box vars (e.g. the manual
`APIDOG_*`); only the box contents are rewritten.

This `API_GATEWAY_URL` is also the correct `server` value for the Apidog
`openapi.yaml` (supersedes the direct `http://localhost:3000` for gateway-routed
testing — see [[mcp-servers]]).

## Testing (end-to-end, not unit)

Floci's known limit: a **second** `terraform apply` fails (`UpdateTags`), and
this change restructures gateway resources — so validate via **teardown +
rebuild** (`make bootstrap`), which applies from scratch. After rebuild, through
`http://localhost:4566/restapis/<api-id>/$default/_user_request_/<path>`:

- `GET /v1/health` → 200 `{"status":"ok"}`
- `POST /v1/users/register` (valid body) → 201
- `POST /v1/users/register` (missing fields) → 400 (Zod validation)
- `GET /v1/users/me` without a JWT → 401 (authorizer active — proves the
  protected-route contract survives)
- `GET /v1/users/me` with a valid JWT → 200

Also assert `.env` contains a correct `API_GATEWAY_URL` after `make env-file`,
and that the `APIDOG_*` lines are preserved.

## Consequences

- Updates the local topology detail in [[ADR-0016-local-apigw-nginx-ecs]] (that
  ADR assumed one integration + IP patching). The prod ADR
  [[ADR-0009-apigw-alb-fargate]] is untouched.
- Adds a small amount of `local_gateway` conditional logic to the module; prod
  path stays the default.

## Related

- [[ADR-0016-local-apigw-nginx-ecs]]
- [[ADR-0009-apigw-alb-fargate]]
- [[mcp-servers]]
