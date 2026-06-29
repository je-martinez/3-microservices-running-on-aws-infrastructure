# Ministack auth-chain spike v2

**Linear issue:** JE-25 — Task 1 (hard dependency gate)

This Terraform stack validates the **REAL local architecture** for the Users Service milestone:

> **Cognito JWT → API GW v2 JWT authorizer → ECS Nginx (reverse proxy) → spike-backend**

The response body `spike-ok-via-nginx` proves traffic traversed the full chain.
GATE VERDICT: **PASS** — unblocks JE-28 (api-gateway module) and JE-30 (compute/ECS module).

---

## Architecture

```
curl GET /protected
  └─> API Gateway v2 HTTP API
        └─> JWT authorizer (Cognito)
              ├─ 401: missing / invalid token
              └─> ECS Nginx task (container on 3mrai_3mrai-network)
                    └─> proxy_pass http://spike-backend:8080  (Docker DNS)
                          └─> spike-backend container
                                └─> HTTP 200 "spike-ok-via-nginx"
```

### Why this topology (vs ALB)

Ministack's ALB emulator only forwards to Lambda targets — `ip` and `instance` target
types return `{"message": "Target type 'ip' not supported."}`. Rather than keeping a
Lambda shim, the new design drops the ALB entirely and uses an Nginx ECS task as a
compose-network-aware reverse proxy. This is the **real local pattern** we want: the
Nginx task (running in Ministack) proxies to any compose service by Docker DNS name,
which is how `develop:watch` containers will be reached in the actual milestone.

---

## Stack contents

| Resource | Purpose |
|---|---|
| `aws_cognito_user_pool` | Issues JWTs used by the authorizer |
| `aws_cognito_user_pool_client` | App client (`ALLOW_ADMIN_USER_PASSWORD_AUTH`, no secret) |
| `aws_iam_role` (`spike_ecs_execution`) | ECS task execution role |
| `aws_vpc` / subnets / `aws_security_group` | Networking substrate (required for awsvpc network mode) |
| `aws_ecs_cluster` | Ministack ECS cluster |
| `aws_ecs_task_definition` (`spike_nginx`) | `nginx:alpine`; config injected via shell `command` |
| `aws_ecs_service` (`spike_nginx`) | Launches Nginx as a real Docker container on `3mrai_3mrai-network` |
| `aws_cloudwatch_log_group` | ECS task log group |
| `aws_apigatewayv2_api` (HTTP) | Entry point; routes `/protected` (JWT) and `/public` (open) |
| `aws_apigatewayv2_authorizer` (JWT) | Validates Cognito IdTokens |
| `aws_apigatewayv2_integration` | HTTP_PROXY pointing to Nginx container IP (updated by smoke-test) |
| **`spike-backend`** (docker-compose service) | `hashicorp/http-echo` returning `spike-ok-via-nginx` on port 8080 |

---

## How to run

### Prerequisites

- `docker compose up -d` — Ministack healthy, spike-backend running
- `terraform apply` already done
- AWS CLI v2, docker CLI

### Apply

```bash
cd infra/environments/local/spike
terraform init
terraform apply -auto-approve
```

No variables required. The Nginx config is injected at task launch via a shell `command`
in the container definition (no custom image or volume mount needed).

### Smoke test

```bash
bash infra/environments/local/spike/smoke-test.sh
```

The script performs all 7 steps end-to-end:

| Step | Action |
|---|---|
| 0 | Ensures `spike-backend` is running on `3mrai_3mrai-network` (starts it if missing) |
| 1 | Reads TF outputs (pool ID, client ID, API ID, integration ID) |
| 2 | Discovers Nginx ECS container IP via `docker inspect` (waits up to 30 s) |
| 3 | Updates API GW integration URI to `http://<nginx-ip>:80/` via AWS CLI |
| 4 | Verifies DNS: `docker exec nginx-container curl spike-backend:8080` |
| 5 | Creates Cognito test user + authenticates (ADMIN_USER_PASSWORD_AUTH) |
| 6 | Unauthenticated `GET /protected` — expect 401 |
| 7 | Authenticated `GET /protected` with Bearer token — expect 200 + `spike-ok-via-nginx` |

---

## Smoke-test result

| Call | Expected | Actual | Body | Verdict |
|---|---|---|---|---|
| DNS check from Nginx container | `spike-ok-via-nginx` | `spike-ok-via-nginx` | — | PASS |
| Unauthenticated `GET /protected` | 401 | **401** | — | PASS |
| Authenticated `GET /protected` | 200 | **200** | `spike-ok-via-nginx` | PASS |

**GATE VERDICT: PASS** — full chain API GW → JWT authorizer → Nginx ECS → spike-backend.

---

## DNS resolution finding (key for JE-30)

`spike-backend` is resolved by Docker's embedded DNS (127.0.0.11) from inside the Nginx
ECS container. Ministack launches ECS tasks as real Docker containers on
`3mrai_3mrai-network`; the compose network's DNS resolver handles all service names on
that network, including `spike-backend` (and, in the real milestone, `users`, `orders`,
`tracking`, `events-pipeline`).

**Verification (step 4):**
```bash
docker exec ministack-ecs-04d9484b-nginx curl -s http://spike-backend:8080/
# → spike-ok-via-nginx
```

No `/etc/hosts` manipulation needed. Docker DNS `127.0.0.11` resolves compose service
names natively from any container on `3mrai_3mrai-network`.

---

## Proven config (port to JE-28 / JE-30)

| Parameter | Value |
|---|---|
| JWT issuer | `https://cognito-idp.us-east-1.amazonaws.com/<user-pool-id>` |
| Audience | `<cognito-app-client-id>` |
| Auth flows | `ALLOW_ADMIN_USER_PASSWORD_AUTH`, `ALLOW_USER_PASSWORD_AUTH`, `ALLOW_REFRESH_TOKEN_AUTH` |
| Identity source | `$request.header.Authorization` |
| API GW integration | `HTTP_PROXY`, `INTERNET`, URI = `http://<nginx-container-ip>:80/` |
| ECS Nginx config | `proxy_pass http://<backend-service>:<port>` with `resolver 127.0.0.11 valid=5s` |
| ECS network | `awsvpc`, containers join `3mrai_3mrai-network` via `LAMBDA_DOCKER_NETWORK` |

**Pattern for production modules:** replace `spike-backend` with the real service name
(e.g. `users`), and replace the container-IP integration URI with a stable ALB DNS name.
The JWT authorizer config is identical between local and production.

---

## Nginx config injection (Ministack ECS)

Ministack ECS task containers cannot mount host volumes. The nginx config is written at
container startup via a shell `command` in the task definition:

```json
"command": [
  "sh", "-c",
  "printf '...' > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"
]
```

The config sets `resolver 127.0.0.11 valid=5s` (Docker's embedded DNS) and uses
`set $backend spike-backend` so Nginx resolves the upstream at request time rather than
at startup — this avoids "host not found in upstream" errors if the backend starts after
Nginx.

---

## Ministack-specific workarounds

1. **AWS provider pinned to `= 5.31.0`**. v5.100 crashes Ministack 1.3.69 with a nil
   pointer panic during resource creation.

2. **Inline security group rules** (`ingress`/`egress` inside `aws_security_group`).
   `aws_vpc_security_group_{ingress,egress}_rule` resources crash on Ministack with
   `index out of range [0] with length 0`.

3. **JWT authorizer issuer = AWS Cognito URL, not localhost**. Ministack issues IdTokens
   with `iss: https://cognito-idp.us-east-1.amazonaws.com/<pool-id>`.

4. **API GW local endpoint = `http://<api-id>.execute-api.localhost:4566`**. The TF
   output `invoke_url` returns a real AWS domain not routable locally.

5. **No ALB**. Ministack's ALB emulator only supports Lambda target type. Replaced with
   direct Nginx ECS container IP in the API GW integration URI.

6. **Integration URI updated post-launch**. The Nginx container IP is not known until
   ECS task launch. The smoke test discovers it via `docker inspect` and calls
   `aws apigatewayv2 update-integration` to patch the URI. In production the integration
   URI is a stable ALB DNS name set at apply time.

7. **`skip_requesting_account_id = true`** (not `skip_requested_account_id`). The
   attribute was renamed in AWS provider v5.

---

## State

The spike stack is **left applied**. To destroy:

```bash
cd infra/environments/local/spike
terraform destroy -auto-approve
docker compose rm -sf spike-backend
```
