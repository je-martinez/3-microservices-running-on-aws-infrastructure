---
title: Gap 1 — nginx+njs injects x-user-id from the JWT (local)
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
  - "[[ADR-0010-cognito-auth]]"
  - "[[users-service-design]]"
---

# Gap 1 — nginx+njs injects x-user-id from the JWT (local)

## Problem

An authenticated request with `Authorization: Bearer <token>` returns **404**:
the users service reads identity from the `x-user-id` header, but nothing
populates it from the JWT. The API Gateway (Floci) validates the token but does
NOT inject a header from the claims — verified across **6 live POCs** (v1/v2
parameter mapping, Lambda-authorizer context, JWT-claims syntax, VPC-Link+ALB,
REST v1): Floci accepts the config but never executes the claim→header mapping.
(In real AWS it works; the emulator doesn't replicate it — see
[[floci-no-claim-header-injection]] if that note exists.)

**Gap 2 is already done** (`db.user.findByIdOrCognitoSub` — the service resolves
a user by `usr_` id OR Cognito `sub`). This spec closes **Gap 1**: getting the
`sub` into the `x-user-id` header, locally.

## Decision

The local nginx ECS reverse proxy (per [[ADR-0016-local-apigw-nginx-ecs]]) is
already in the request path. Add an **njs** script to it that decodes the JWT
from the `Authorization` header, extracts `sub`, and sets
`proxy_set_header x-user-id <sub>` before proxying to users.

Verified live in the POC: `nginx:alpine` ships njs
(`/etc/nginx/modules/ngx_http_js_module.so`, `/usr/bin/njs`); a standalone conf
with `load_module` + `js_import`/`js_set` passed `nginx -t` and injected the
correct sub from a real Floci token. A full end-to-end POC (API GW → nginx+njs →
users) is what this spec productionizes.

**Chosen over** the Lambda-proxy alternative (also POC'd working) because nginx
is already in the path — njs adds no extra hop or resource, whereas a Lambda
proxy adds a per-request Lambda invocation. **Local-only:** no prod IaC here;
prod uses the API Gateway's native claim→header mapping in its own deploy
milestone.

## Design — mount config files via a host volume (Floci supports it)

**Key finding (contradicts [[ADR-0016-local-apigw-nginx-ecs]]):** ADR-0016
assumed "ECS cannot mount host volumes" (inherited from Ministack) and therefore
embedded the nginx config in the task `command`. **Floci DOES support host
volumes** — verified live: an ECS task def with
`volumes: [{ host: { sourcePath } }]` + a container `mountPoints` entry mounted a
host file into the container (`cat` returned its exact contents).

So instead of embedding config in a fragile `printf`, we serve **both** the njs
script and a full `nginx.conf` as **real files** checked into
`infra/modules/compute/nginx/`, mounted into the nginx container. The task
`command` becomes trivial (just `nginx -c`), and the files are editable with
real tooling (syntax highlighting, no escaping).

### Files checked in — `infra/modules/compute/nginx/`

**`auth.js`** (njs script, verbatim from the POC):

```js
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

**`nginx.conf`** (full config — `load_module` is a main-context directive that
cannot live in a `conf.d/*.conf` snippet, so we ship a complete config):

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
      set $backend BACKEND_SERVICE_NAME;
      proxy_pass http://$backend:BACKEND_PORT;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header x-user-id $jwt_sub;
    }
  }
}
```

> `BACKEND_SERVICE_NAME`/`BACKEND_PORT`: these were Terraform interpolations
> (`${var.backend_service_name}`) in the old embedded command. As a static file
> they can't interpolate. Two options for the implementer: (a) `templatefile()`
> the `nginx.conf` so Terraform substitutes them into the mounted file at apply
> time (keeps them parameterized), or (b) hardcode `users`/`3000` in the file
> since this is local-only (matches the module's existing defaults). Prefer
> `templatefile()` to keep parity with `var.backend_service_name`/`var.backend_port`.

### Terraform changes (`infra/modules/compute/main.tf` + variables)

1. New variable for the host path (parameterized, not hardcoded):
   ```hcl
   variable "nginx_config_host_path" {
     type        = string
     default     = "" # empty → module computes abspath("${path.module}/nginx")
     description = "Absolute host path to the dir holding auth.js + nginx.conf, bind-mounted into the nginx task (Floci host volume). Local-only."
   }
   ```
   In `main.tf`: `local.nginx_dir = var.nginx_config_host_path != "" ? var.nginx_config_host_path : abspath("${path.module}/nginx")`.

2. Task definition gains a `volumes` block + the container gains `mountPoints`:
   ```hcl
   volume {
     name      = "nginx-config"
     host_path = local.nginx_dir
   }
   ```
   and in the container definition JSON:
   ```json
   "mountPoints": [
     { "sourceVolume": "nginx-config", "containerPath": "/etc/nginx/mounted", "readOnly": true }
   ]
   ```
   (Use `containerPath` = a dir; the files land at `/etc/nginx/mounted/auth.js`
   and `/etc/nginx/mounted/nginx.conf`. Adjust the `js_import` path in
   `nginx.conf` to `/etc/nginx/mounted/auth.js` to match.)

3. The `command` collapses to just launching nginx with the mounted config:
   ```
   command = ["nginx", "-c", "/etc/nginx/mounted/nginx.conf", "-g", "daemon off;"]
   ```
   No more `printf`. If `templatefile()` is used for `nginx.conf`, a tiny
   pre-step may `envsubst`/copy the rendered file — but simplest is: Terraform
   renders `nginx.conf` to the mounted dir at apply (via `local_file`), or the
   file is static with `users`/`3000`.

> Validate `nginx -t -c /etc/nginx/mounted/nginx.conf` inside the running
> container after rebuild. The file CONTENTS (njs + config) are POC-verified;
> only the mount wiring is new — and the mount mechanism itself is verified.

## Behavior notes

- **No signature validation** — njs decodes the payload only. The API Gateway
  JWT authorizer already validated the token (ADR-0010: the service trusts the
  authorizer). njs just extracts the claim.
- **Missing/malformed token** → `jwtSub` returns `''` → `x-user-id` empty → the
  service answers 401/404 per route. Safe; nothing throws.
- **Public routes** (health/register/login) carry an empty `x-user-id` and ignore
  it — unchanged behavior.
- The `sub` is injected; Gap 2's `findByIdOrCognitoSub` resolves it to the user.

## Testing (end-to-end, teardown + rebuild)

The nginx task definition changes, and Floci forbids a 2nd `terraform apply`, so
validate via **`make bootstrap`** (from-scratch rebuild). After rebuild, with a
real ID token (`admin-initiate-auth`), through the gateway
(`http://localhost:4566/restapis/<api-id>/$default/_user_request_/<path>`):

- `GET /v1/users/me` with `Authorization: Bearer <token>` → **200** with the
  caller's profile (was 404). This is the headline: Bearer-token auth works E2E.
- `GET /v1/users/me` **without** a token → 401 (authorizer still enforces).
- `POST /v1/users/register` (public) → 201 (unaffected).
- Confirm in nginx logs / by a header echo that `x-user-id` carries the sub for
  authenticated requests, empty for anonymous ones.
- `nginx -t` passes in the rebuilt container (config is valid).

## Non-goals (YAGNI)

- No prod IaC (no API Gateway `request_parameters`); prod uses native
  claim→header mapping in its deploy milestone (which doesn't exist yet).
- No signature verification in nginx (authorizer already did it).
- No Lambda-proxy alternative (rejected — extra hop; njs is in-path).
- No custom nginx Docker image — config ships as checked-in files bind-mounted
  via a Floci host volume (which this spec proves ADR-0016 wrongly ruled out).
- No change to the users service (Gap 2 already accepts the sub) or the API
  Gateway module.

## Consequences

- The local nginx now does light JWT decoding (a documented local-only
  responsibility). ADR-0016's "keep nginx config minimal" note gets a scoped
  exception: one `js_set` + one `proxy_set_header`, justified by the emulator's
  missing claim→header mapping. Worth a line in ADR-0016.
- Bearer-token auth works end-to-end locally, matching how prod will behave
  (even though the mechanism differs: njs local, gateway-native prod).
- **ADR-0016 correction:** it claimed local ECS "cannot mount host volumes" and
  chose command-embedded config for that reason. This spec proves Floci DOES
  support host volumes (verified). The nginx config moves to checked-in files
  (`infra/modules/compute/nginx/{auth.js,nginx.conf}`) bind-mounted in — cleaner
  than the old `printf`. ADR-0016 should be updated (or superseded) to note this.
- The mounted `sourcePath` is an absolute HOST path (`abspath(path.module)`), so
  it is portable across machines that check out the repo; no hardcoded user path.

## Related

- [[ADR-0016-local-apigw-nginx-ecs]]
- [[ADR-0010-cognito-auth]]
- [[users-service-design]]
