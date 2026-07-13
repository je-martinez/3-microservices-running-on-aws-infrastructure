# Gap 1 — nginx+njs injects x-user-id — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The local nginx ECS proxy decodes the JWT from `Authorization` and injects `x-user-id: <sub>` before proxying to users, so authenticated requests with `Authorization: Bearer <token>` resolve end-to-end (Gap 2 already maps the sub to the user).

**Architecture:** Ship `auth.js` (njs) + `nginx.conf` as checked-in files under `infra/modules/compute/nginx/`, bind-mounted into the nginx task via a Floci host volume (verified supported). The task `command` collapses to `nginx -c`. Local-only; prod uses the API Gateway's native claim→header mapping in its own milestone.

**Tech Stack:** Terraform, ECS (Floci), nginx:alpine + njs, Make, bash.

## Global Constraints

- **Terraform** via `terraform -chdir=infra/environments/local` from repo root. Module dir: `infra/modules/compute/`.
- **Floci:** a SECOND `terraform apply` fails (`UpdateTags`) — validate via teardown + rebuild (`make bootstrap`), never a re-apply. AWS provider stays pinned `= 5.31.0`.
- **Local-only:** no prod IaC, no API Gateway change, no users-service change (Gap 2 already accepts the sub). `terraform fmt` must pass.
- **Verified facts:** `nginx:alpine` ships njs (`/etc/nginx/modules/ngx_http_js_module.so`); Floci supports ECS host volumes (POC: a host file mounted into the container and `cat` returned its contents); the njs `jwtSub` script + full `nginx.conf` passed `nginx -t` and injected the correct sub in the POC.
- **backend host/port:** local module defaults are `users` / `3000`. Since the config is now a static file (not a Terraform-interpolated command), hardcode `users`/`3000` in `nginx.conf` (local-only; matches defaults). Do NOT introduce `templatefile()` complexity unless the module's backend vars diverge from the defaults.
- **Git:** `infra-impl` writes only Terraform/config, never git/Linear. Main session commits.
- **Language:** config/comments English; converse in Spanish.

---

### Task 1: Add the checked-in nginx config files

**Files:**
- Create: `infra/modules/compute/nginx/auth.js`
- Create: `infra/modules/compute/nginx/nginx.conf`

**Interfaces:**
- Produces: two files mounted read-only into the nginx container at `/etc/nginx/mounted/` (Task 2 wires the mount).

- [ ] **Step 1: Create `infra/modules/compute/nginx/auth.js`** (verbatim from the POC)

```js
// njs: decode the Cognito JWT from Authorization and return its `sub`.
// No signature check — the API Gateway JWT authorizer already validated the
// token (ADR-0010); this only extracts the claim so nginx can forward it as
// the x-user-id header the users service reads.
function jwtSub(r) {
  var auth = r.headersIn['Authorization'] || '';
  var token = auth.replace(/^Bearer\s+/i, '');
  var parts = token.split('.');
  if (parts.length < 2) return '';
  try {
    var payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4) payload += '=';
    var claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return claims.sub || '';
  } catch (e) { return ''; }
}
export default { jwtSub };
```

- [ ] **Step 2: Create `infra/modules/compute/nginx/nginx.conf`** (full config)

```nginx
load_module modules/ngx_http_js_module.so;
events {}
http {
  js_import auth from /etc/nginx/mounted/auth.js;
  js_set $jwt_sub auth.jwtSub;
  server {
    listen 80;
    location / {
      resolver 127.0.0.11 valid=5s;
      set $backend users;
      proxy_pass http://$backend:3000;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header x-user-id $jwt_sub;
    }
  }
}
```

- [ ] **Step 3: Sanity-check the njs + conf parse (against the running nginx image)**

Run (uses the currently-running nginx container just to validate syntax; does not change infra):
```bash
NGINX=$(docker ps --format '{{.Names}}' | grep -iE "floci-ecs.*nginx" | head -1)
docker cp infra/modules/compute/nginx/auth.js "$NGINX:/tmp/auth.js"
docker cp infra/modules/compute/nginx/nginx.conf "$NGINX:/tmp/nginx.conf"
# point js_import at the temp copy for the check
docker exec "$NGINX" sh -c "sed 's#/etc/nginx/mounted/#/tmp/#' /tmp/nginx.conf > /tmp/check.conf && nginx -t -c /tmp/check.conf"
```
Expected: `nginx: configuration file /tmp/check.conf test is successful`. Clean up the temp files afterward (`docker exec "$NGINX" rm -f /tmp/auth.js /tmp/nginx.conf /tmp/check.conf`).

- [ ] **Step 4: Commit** *(main session)*

---

### Task 2: Wire the host-volume mount + simplify the task command

**Files:**
- Modify: `infra/modules/compute/main.tf`
- Modify: `infra/modules/compute/variables.tf`

**Interfaces:**
- Consumes: the files from Task 1.
- Produces: the nginx task mounts `infra/modules/compute/nginx/` at `/etc/nginx/mounted/` and starts with the mounted config.

- [ ] **Step 1: Add the host-path variable + local**

In `infra/modules/compute/variables.tf`:
```hcl
variable "nginx_config_host_path" {
  type        = string
  default     = ""
  description = "Absolute host path to the dir with auth.js + nginx.conf, bind-mounted into the nginx task (Floci host volume). Empty → module uses abspath(path.module)/nginx. Local-only."
}
```
In `infra/modules/compute/main.tf` (near the top, add a `locals`):
```hcl
locals {
  nginx_dir = var.nginx_config_host_path != "" ? var.nginx_config_host_path : abspath("${path.module}/nginx")
}
```

- [ ] **Step 2: Add the `volume` block + `mountPoints`; replace the command**

In the `aws_ecs_task_definition.nginx` resource:

Add a `volume` block (sibling of `container_definitions`, inside the resource):
```hcl
  volume {
    name      = "nginx-config"
    host_path = local.nginx_dir
  }
```

In the container definition JSON, REPLACE the `command = [...]` (the whole `printf`/`join` block) with:
```hcl
      command = ["nginx", "-c", "/etc/nginx/mounted/nginx.conf", "-g", "daemon off;"]
```
And ADD a `mountPoints` key to the container definition (sibling of `command`):
```hcl
      mountPoints = [
        {
          sourceVolume  = "nginx-config"
          containerPath = "/etc/nginx/mounted"
          readOnly      = true
        }
      ]
```
Update the stale comment above the (removed) command block: it described writing `conf.d/default.conf` via printf; replace with a note that config is bind-mounted from `local.nginx_dir` (a checked-in dir) — Floci supports host volumes (correcting the old ADR-0016 assumption).

- [ ] **Step 3: Format + validate**

Run:
```bash
terraform -chdir=infra/modules/compute fmt
terraform -chdir=infra/environments/local fmt
terraform -chdir=infra/environments/local validate
```
Expected: `Success! The configuration is valid.` Do NOT `apply` (Floci 2nd-apply limit).

- [ ] **Step 4: Commit** *(main session)*

---

### Task 3: End-to-end verification (teardown + rebuild)

**Files:** none (verification only).

> Requires a full local rebuild (`make bootstrap`) — Floci forbids a 2nd apply, and the nginx task def changed. This resets Cognito/DB IDs and regenerates `.env`. Run as one deliberate step; NEEDS the user's explicit OK before running (it is destructive to the current local state).

- [ ] **Step 1: Rebuild**

```bash
make bootstrap
```
Expected: apply succeeds (nginx task with the mount), users up, bootstrap.sh OK (nginx-stable alias). If apply fails on `UpdateTags`, `make clean` then retry.

- [ ] **Step 2: Confirm the mount + njs loaded**

```bash
NGINX=$(docker ps --format '{{.Names}}' | grep -iE "floci-ecs.*nginx" | head -1)
docker exec "$NGINX" sh -c 'ls -la /etc/nginx/mounted/ && nginx -t -c /etc/nginx/mounted/nginx.conf'
```
Expected: `auth.js` + `nginx.conf` present; `nginx -t` successful.

- [ ] **Step 3: The headline test — Bearer token works E2E**

```bash
export AWS_ENDPOINT_URL=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
source .env
API_ID=$(terraform -chdir=infra/environments/local output -raw api_id)
BASE="http://localhost:4566/restapis/$API_ID/\$default/_user_request_"
# register + login
curl -s -X POST "$BASE/v1/users/register" -H "Content-Type: application/json" \
  -d '{"email":"gap1@example.co","password":"P@ssw0rd!2026","fullName":"Gap1"}' >/dev/null
aws cognito-idp admin-set-user-password --user-pool-id "$COGNITO_USER_POOL_ID" --username gap1@example.co --password 'P@ssw0rd!2026' --permanent --endpoint-url http://localhost:4566
TOK=$(aws cognito-idp admin-initiate-auth --user-pool-id "$COGNITO_USER_POOL_ID" --client-id "$COGNITO_CLIENT_ID" --auth-flow ADMIN_NO_SRP_AUTH --auth-parameters USERNAME=gap1@example.co,PASSWORD='P@ssw0rd!2026' --endpoint-url http://localhost:4566 | python3 -c "import sys,json;print(json.load(sys.stdin)['AuthenticationResult']['IdToken'])")
echo "me WITH bearer:    $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK" "$BASE/v1/users/me")"   # expect 200
echo "me WITHOUT token:  $(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/users/me")"                                    # expect 401
echo "register (public): $(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/users/register" -H 'Content-Type: application/json' -d '{"email":"x@y.co","password":"P@ssw0rd!2026","fullName":"X"}')"  # expect 201
```
Expected: **me WITH bearer → 200** (the goal — authenticated Bearer-token request resolves the user), me WITHOUT token → 401, register → 201.

- [ ] **Step 4: Confirm nginx injected the sub**

```bash
docker logs "$NGINX" 2>&1 | tail -5
```
(Optionally add a temporary `log_format` capturing `$jwt_sub` if deeper proof is wanted.) The 200 in Step 3 is the primary evidence the header was injected.

---

## Self-Review

**Spec coverage:**
- njs + full nginx.conf as checked-in files → Task 1. ✓
- Host-volume mount + simplified command → Task 2. ✓
- Host path parameterized (`abspath(path.module)`, portable) → Task 2 Step 1. ✓
- E2E Bearer-token test via rebuild → Task 3. ✓
- No prod IaC / no service / no gateway change → Global Constraints. ✓
- `x-user-id = sub`, Gap 2 resolves it → nginx.conf `proxy_set_header x-user-id $jwt_sub`. ✓

**Placeholder scan:** No TBD/TODO; auth.js + nginx.conf are complete (POC-verified); backend host/port hardcoded `users`/`3000` per the local-only decision.

**Type consistency:** `sourceVolume "nginx-config"` matches the `volume { name = "nginx-config" }`; mount `containerPath /etc/nginx/mounted` matches `js_import .../mounted/auth.js` and `nginx -c /etc/nginx/mounted/nginx.conf`.

**Known risk:** Task 3 depends on a clean Floci rebuild; if `make bootstrap` hits the 2nd-apply bug, `make clean` then retry (noted). Needs user OK before running (destructive to local state).

## Related

- [[2026-07-11-gap1-nginx-njs-xuserid-design]]
- [[ADR-0016-local-apigw-nginx-ecs]]
