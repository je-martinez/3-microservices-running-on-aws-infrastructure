---
title: "Orders API Gateway Integration"
type: plan
area: infra
status: draft
created: 2026-07-15
updated: 2026-07-15
tags: [type/plan, area/infra, status/draft]
related: ["[[2026-07-15-orders-gateway-integration-design]]", "[[orders-service-design]]", "[[2026-07-14-orders-service-milestone-design]]", "[[ADR-0016-local-apigw-nginx-ecs]]", "[[ADR-0009-apigw-alb-fargate]]", "[[ADR-0010-cognito-auth]]", "[[ADR-0017-floci-local]]", "[[versioning]]", "[[local-dev-floci]]"]
---

# Orders API Gateway Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the Orders service through the existing local API Gateway → nginx front door (by path prefix, alongside Users), and resolve the `/v1/health` collision by exposing per-service health (`/v1/users/health`, `/v1/orders/health`).

**Architecture:** nginx's static `nginx.conf` gains a `location /v1/orders/` proxying to `orders:8080` (with the same njs `x-user-id` injection Users gets), plus health rewrites so each service's unprefixed `/v1/health` is reachable under its prefix. The API Gateway `local.routes` table adds the Orders routes and replaces the bare `/v1/health` with `/v1/users/health`. The `compute` module's nginx.conf is a STATIC bind-mounted file (its `backend_service_name`/`backend_port` vars are vestigial and unused) — so the routing change is edited directly in the file, not parameterized.

**Tech Stack:** nginx + njs (ngx_http_js_module), Terraform (AWS provider `= 5.31.0`), API Gateway v2 on Floci, Docker Compose.

## Global Constraints

- **Local only.** Touch `infra/modules/compute/nginx/nginx.conf`, `infra/modules/api-gateway/main.tf` (+ its route table), and any `.http`/docs referencing the gateway `/v1/health`. Prod (`local_gateway = false`) uses a single shared integration and is NOT the focus; keep the route table changes valid for both modes.
- **Identity:** nginx injects `x-user-id = $jwt_sub` (Cognito sub via njs) on EVERY proxied location — Orders needs it. The new Orders location MUST keep this injection.
- **Health rewrite is health-only.** `/v1/orders/health` → `orders:8080/v1/health` and `/v1/users/health` → `users:3000/v1/health` are REWRITES (services serve health unprefixed). Orders' FUNCTIONAL routes (`/v1/orders`, `/v1/orders/my-orders`, `/v1/orders/{id}`) are NOT rewritten — proxy preserving the path. Comment this in nginx.conf so nobody "fixes" it.
- **nginx targets the IN-NETWORK port:** `orders:8080` (ASPNETCORE_URLS), NOT `3001` (the host-published port).
- **Language:** converse in Spanish; write config/comments in English.
- **Implementers write only config/Terraform.** Leave work in the working tree; the main session commits.

---

## Task 1: nginx.conf — route /v1/orders to orders:8080 + per-service health

**Files:**
- Modify: `infra/modules/compute/nginx/nginx.conf`

**Interfaces:**
- Consumes: the `$jwt_sub` njs variable (already set at the http level).
- Produces: nginx routing `/v1/orders/*` → `orders:8080`, `/v1/orders/health` → `orders:8080/v1/health`, `/v1/users/health` → `users:3000/v1/health`, and everything else → `users:3000` (unchanged default).

- [ ] **Step 1: Rewrite the server block with per-prefix locations**

Replace the single `location /` in `infra/modules/compute/nginx/nginx.conf` with the routing below. Order matters — nginx matches the most specific prefix first; use exact-match for health so it wins over the functional prefix:

```nginx
load_module modules/ngx_http_js_module.so;
events {}
http {
  js_import auth from /etc/nginx/mounted/auth.js;
  js_set $jwt_sub auth.jwtSub;

  # Shared proxy headers (identity injection MUST apply to every backend: the
  # njs-decoded Cognito sub is how both services learn the caller).
  server {
    listen 80;
    resolver 127.0.0.11 valid=5s;

    # ── Health, per service (exact match wins over the /v1/orders/ prefix) ──
    # Both services serve /v1/health UNPREFIXED internally, so we REWRITE the
    # prefixed gateway path to the bare service path. HEALTH-ONLY rewrite — do
    # NOT extend this to functional routes (they use their real paths).
    location = /v1/users/health {
      set $backend users;
      proxy_pass http://$backend:3000/v1/health;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header x-user-id $jwt_sub;
    }
    location = /v1/orders/health {
      set $backend orders;
      proxy_pass http://$backend:8080/v1/health;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header x-user-id $jwt_sub;
    }

    # ── Orders functional routes (path preserved — these ARE the real paths) ──
    location /v1/orders {
      set $backend orders;
      proxy_pass http://$backend:8080;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header x-user-id $jwt_sub;
    }

    # ── Everything else → Users (default; unchanged behavior) ──
    location / {
      set $backend users;
      proxy_pass http://$backend:3000;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header x-user-id $jwt_sub;
    }
  }
}
```

> Why `proxy_pass http://$backend:8080;` WITHOUT a trailing path for the functional `location /v1/orders` — when proxy_pass has no URI, nginx passes the original request URI unchanged (so `/v1/orders/my-orders` reaches the service as `/v1/orders/my-orders`). The health locations DO include a URI (`/v1/health`), which triggers the rewrite. This is the exact nginx semantic that makes health rewrite but functional routes pass through. The `set $backend` + resolver keeps DNS re-resolution on container recreation (per the existing pattern).

- [ ] **Step 2: Validate nginx config syntax (dockerized nginx -t)**

Run (mounts the config + auth.js the way the ECS task does):

```bash
docker run --rm -v "$(pwd)/infra/modules/compute/nginx:/etc/nginx/mounted:ro" \
  nginx:latest sh -c "nginx -c /etc/nginx/mounted/nginx.conf -t" 2>&1 | tail -5
```

Expected: `syntax is ok` / `test is successful`. If it complains about `ngx_http_js_module` not loaded (the base `nginx` image may lack njs), use `nginxinc/nginx-unprivileged` or the njs-enabled image the project uses; if njs can't be loaded in a bare check, at minimum confirm no non-njs syntax errors and rely on the E2E run in Task 3.

- [ ] **Step 3: Commit**

```bash
git add infra/modules/compute/nginx/nginx.conf
git commit -m "feat(infra): route /v1/orders through nginx to orders:8080 with per-service health"
```

---

## Task 2: API Gateway route table — add Orders routes, split health

**Files:**
- Modify: `infra/modules/api-gateway/main.tf` (the `local.routes` map)

**Interfaces:**
- Consumes: nothing new (uses the existing per-route integration machinery).
- Produces: gateway routes for Orders + `/v1/users/health`, replacing the bare `/v1/health`.

- [ ] **Step 1: Update the routes map**

In `infra/modules/api-gateway/main.tf`, edit `local.routes`. Replace the `health` entry (bare `/v1/health`) with `users_health`, and add the Orders routes. Keep the same `{ key, path, auth }` shape the module already uses:

```hcl
  routes = merge(
    {
      register = { key = "POST /v1/users/register", path = "/v1/users/register", auth = false }
      login    = { key = "POST /v1/users/login", path = "/v1/users/login", auth = false }
      refresh  = { key = "POST /v1/users/refresh", path = "/v1/users/refresh", auth = false }
      get_me   = { key = "GET /v1/users/me", path = "/v1/users/me", auth = true }
      patch_me = { key = "PATCH /v1/users/me", path = "/v1/users/me", auth = true }

      # Per-service health (replaces the bare GET /v1/health, which used to hit
      # Users only). nginx rewrites each to the service's unprefixed /v1/health.
      users_health  = { key = "GET /v1/users/health", path = "/v1/users/health", auth = false }
      orders_health = { key = "GET /v1/orders/health", path = "/v1/orders/health", auth = false }

      # Orders functional routes. {order_id} is a path parameter; the module's
      # local per-route integration bakes the literal path into the URI, so use
      # the APIGW proxy-param form the other parameterized routes use if any —
      # otherwise the concrete path. See note below on {order_id}.
      create_order   = { key = "POST /v1/orders", path = "/v1/orders", auth = true }
      my_orders      = { key = "GET /v1/orders/my-orders", path = "/v1/orders/my-orders", auth = true }
      get_order      = { key = "GET /v1/orders/{order_id}", path = "/v1/orders/{order_id}", auth = true }
    },
    var.enable_e2e_cleanup_route ? {
      e2e_cleanup = { key = "DELETE /v1/users/e2e-cleanup", path = "/v1/users/e2e-cleanup", auth = false }
    } : {}
  )
```

> **On `{order_id}`:** the gateway route key uses `{order_id}` (APIGW path param). In LOCAL mode the module builds one HTTP_PROXY integration per route with `path` baked into the integration URI (`${nginx_base_uri}${path}`) — a literal `/v1/orders/{order_id}` URI won't substitute the param on Floci (Floci drops the path anyway; nginx matches the `/v1/orders` prefix and forwards the real request URI). VERIFY at implementation how the existing parameterized route (`GET /v1/users/me` is not parameterized — there may be NO precedent). If Floci can't handle the `{order_id}` integration URI, the pragmatic local approach is: the ROUTE key keeps `{order_id}` (so APIGW matches), but the integration targets the `/v1/orders` nginx prefix (nginx forwards the full path to orders:8080). Document whichever works; prod (real AWS, path preserved) handles `{order_id}` natively.

- [ ] **Step 2: Format + validate**

Run:

```bash
cd infra/environments/local && terraform fmt -recursive && terraform validate
```

Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
git add infra/modules/api-gateway/main.tf
git commit -m "feat(infra): add Orders routes to the API gateway; split /v1/health per service"
```

---

## Task 3: End-to-end validation via the gateway + fix references

**Files:**
- Modify: any `.http` files referencing the gateway `/v1/health` (search)
- Modify: `docs`/runbooks referencing the bare gateway `/v1/health` (via obsidian-vault if in docs/)

**Interfaces:**
- Consumes: everything above.
- Produces: proof that Orders is reachable through the gateway and Users isn't regressed.

> **This task requires a live Floci run.** The stack must be up (or re-bootstrapped). nginx config is bind-mounted, so a change needs the nginx ECS task recreated — a `terraform apply` (or re-bootstrap) does that.

- [ ] **Step 1: Apply the gateway change + recreate nginx**

Bring the change live. Since nginx.conf is bind-mounted into the ECS task and the routes changed, re-apply phase 1 (from a clean state per the Floci re-apply guidance) or, if the stack is up, re-run the apply so the api-gateway routes update and re-run `bootstrap.sh` so the nginx-stable alias re-attaches to the recreated task:

```bash
make clean && make bootstrap
```

> Per the Floci re-apply limitation, prefer a from-scratch `make clean && make bootstrap`. Discover the gateway URL after: `grep API_GATEWAY_URL .env`.

- [ ] **Step 2: Verify per-service health through the gateway**

Run (substitute the discovered gateway base from `.env`):

```bash
GW="$(grep -oE 'http://localhost:4566/restapis/[^ ]*' .env | head -1)"
echo "users_health:  $(curl -sf -m5 "$GW/v1/users/health")"
echo "orders_health: $(curl -sf -m5 "$GW/v1/orders/health")"
```

Expected: BOTH print `{"status":"ok"}` — Users via rewrite, Orders via the new backend + rewrite.

- [ ] **Step 3: Verify an Orders functional route through the gateway**

Run (a real order needs a JWT + seeded product; at minimum verify routing reaches Orders, e.g. a 401/validation from Orders proves the path lands there, not a 404 from nginx/Users):

```bash
GW="$(grep -oE 'http://localhost:4566/restapis/[^ ]*' .env | head -1)"
curl -s -m5 -o /dev/null -w "%{http_code}\n" "$GW/v1/orders/my-orders"
```

Expected: a response FROM Orders (401 without identity, or 200 with it) — NOT a 404 (which would mean nginx routed it to Users). Confirm in `docker logs 3mrai-orders-1` that the request arrived.

- [ ] **Step 4: No regression on Users**

```bash
GW="$(grep -oE 'http://localhost:4566/restapis/[^ ]*' .env | head -1)"
curl -s -m5 -o /dev/null -w "login:%{http_code}\n" -X POST "$GW/v1/users/login" -H 'content-type: application/json' -d '{}'
```

Expected: a response from Users (400/401 for the empty body), proving Users routes still resolve.

- [ ] **Step 5: Repoint stale `/v1/health` references**

Search and fix references to the OLD bare gateway health:

```bash
grep -rn "v1/health" --include=*.http --include=*.md . | grep -v "v1/users/health\|v1/orders/health\|node_modules\|/dist/"
```

For `.http` files: repoint the gateway ones to `/v1/users/health` (or `/v1/orders/health`). For any `docs/` runbook (e.g. local-dev-floci) that lists `curl .../v1/health` as the gateway check, route that edit through the obsidian-vault agent. The DIRECT per-container checks (`localhost:3000/v1/health`, `localhost:3001/v1/health`) do NOT change — leave them.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test(infra): repoint gateway health references to per-service paths"
```

---

## Self-review — spec coverage

- §1 nginx multi-backend by prefix (location /v1/orders → orders:8080, x-user-id injection on both) → Task 1. ✓ (Resolves the spec's open question on the compute multi-backend variable: nginx.conf is a STATIC file, backend vars are vestigial — edit the file directly, no new variable needed.)
- §1 Orders routes in the gateway table → Task 2. ✓
- §2 health by prefix with nginx REWRITE, functional routes NOT rewritten → Task 1 (Step 1 + the proxy_pass URI note). ✓
- §2 remove bare /v1/health → /v1/users/health, flag the contract change → Task 2 + Task 3 Step 5. ✓
- §3a per-route auth (orders write/read auth=true, health auth=false) → Task 2. ✓
- §3b identity: x-user-id injection on the Orders location → Task 1 (kept in every location). ✓
- §3c testing: fmt/validate + e2e via gateway (both healths, an Orders route, Users no-regression) + repoint .http/docs → Tasks 2-3. ✓
- Open questions: multi-backend var shape → N/A (static nginx.conf); njs injection identical per-backend → yes (same in every location); bare /v1/health removal → Task 3 Step 5 verifies/repoints; orders:8080 not 3001 → Global Constraints + Task 1. ✓

## Related

- [[2026-07-15-orders-gateway-integration-design]]
- [[orders-service-design]]
- [[2026-07-14-orders-service-milestone-design]]
- [[ADR-0016-local-apigw-nginx-ecs]]
- [[ADR-0009-apigw-alb-fargate]]
- [[ADR-0010-cognito-auth]]
- [[ADR-0017-floci-local]]
- [[versioning]]
- [[local-dev-floci]]
