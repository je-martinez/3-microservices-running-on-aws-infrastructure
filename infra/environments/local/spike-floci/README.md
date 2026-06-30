# Floci auth-chain spike

Validates the 3MRAI local auth chain on **Floci** (A/B against the Ministack
spike in `../spike/`). Spec: `docs/superpowers/specs/2026-06-29-floci-local-emulator-spike-design.md`.

> **GATE VERDICT: PASS** — the full chain works on Floci.
> Cognito JWT → API GW v2 JWT authorizer → ECS Nginx → spike-backend, all green.
> Functionally equivalent to Ministack; some quirks differ (see Findings).

## Architecture

```
curl GET /protected
  └─> API Gateway v2 HTTP API (Floci, :4566)
        └─> JWT authorizer (Cognito on Floci)
              ├─ 401: missing / invalid token
              └─> ECS Nginx task (real Docker container on 3mrai_3mrai-network)
                    └─> proxy_pass http://spike-backend:8080  (Docker DNS by container_name)
                          └─> spike-backend → HTTP 200 "spike-ok-via-floci"
```

## How to run

```bash
# 1. Bring up Floci + spike-backend (defined in docker-compose.yml; Ministack is
#    commented out there). Floci replaces Ministack on :4566.
docker compose up -d floci spike-backend

# 2. Apply the spike stack
cd infra/environments/local/spike-floci
terraform init
terraform apply -auto-approve     # NOTE: recreates the nginx ECS task each run

# 3. Attach the stable DNS alias to the (re)created nginx container (idempotent).
#    The API GW integration is FIXED at http://nginx-stable/ — no IP patch.
bash bootstrap.sh

# 4. Run the gate
bash smoke-test.sh
# → GATE VERDICT: PASS — full chain works on Floci, NO IP patch (stable DNS alias)
```

### Stable DNS alias — killing the IP patch (mock Route53 via Docker DNS)

The original problem: Floci launches the nginx ECS task as a Docker container whose
name and IP **change on every `terraform apply`** (the task is recreated). The naive
fix (and Ministack's `bootstrap.sh`) discovers that volatile IP via `docker inspect`
and PATCHES the API GW integration each run — fragile and it mutates Terraform infra.

**Solution (verified):** attach a CONSTANT Docker-network alias (`nginx-stable`,
optional fixed IP `192.168.155.20`) to whichever nginx container is running, and
point the API GW integration at `http://nginx-stable/` permanently in `main.tf`.
Docker embedded DNS (`127.0.0.11`) resolves the alias from anywhere on the network —
**including Floci's API GW container** (verified). So:

- the integration URI is correct at apply time and **never changes** (no patch);
- after a task recreation, `bootstrap.sh` just re-attaches the same alias — Terraform
  state and the integration stay untouched;
- it is idempotent and carries no dynamic data.

This is the local "mock Route53": Floci's Route53 is **management-plane only** (its
docs: *"actual DNS resolution is not provided"*) and ECS tasks aren't registered in
Cloud Map, so a Docker-native alias is the working stable-DNS mechanism — which is
exactly what Floci's own docs recommend ("for custom hostname resolution to container
IPs, use Docker's native networking").

**Proven across a task recreation:** `terraform apply` (new task id + IP) → integration
still `http://nginx-stable/` (untouched) → `bootstrap.sh` re-attaches alias → gate PASS.

### Local invoke URL (Floci-specific)

Floci uses the **LocalStack-style** invoke path, NOT `<api-id>.execute-api.localhost:4566`
(that path is captured by Floci's S3 handler and returns `NoSuchBucket`):

```
http://localhost:4566/restapis/<api-id>/$default/_user_request_/<path>
```

## Findings — Floci vs Ministack

| Concern | Ministack | Floci (this spike) |
|---|---|---|
| AWS provider version | pinned `5.31.0` (v5.100 panics) | **still pinned `5.31.0`** — v5.100 fails `aws_cognito_user_pool_client` with "inconsistent result"; 5.31 works (with the workaround below) |
| `aws_cognito_user_pool_client` apply | OK | **Floci returns `AnalyticsConfiguration:{}` (empty)** → provider aborts apply. Workaround: `lifecycle { ignore_changes = [analytics_configuration] }` in `main.tf`. Resource is created & functional regardless. |
| Separate SG rule resources (`aws_vpc_security_group_*_rule`) | crash → inline required | ✅ **WORK** — no inline workaround needed (a Ministack quirk eliminated) |
| ECS task as real Docker container | ✅ via `LAMBDA_DOCKER_NETWORK` | ✅ via `FLOCI_SERVICES_ECS_DOCKER_NETWORK=3mrai_3mrai-network` |
| Docker DNS to backend by `container_name` | ✅ | ✅ nginx resolves `spike-backend:8080` → `spike-ok-via-floci` |
| ALB `ip` target | unsupported → Nginx ECS | not retried; Nginx ECS pattern kept (works) |
| Cloud Map / Route53 DNS-first | not used | ❌ **NOT viable** — Floci's Route53 is management-plane only (no resolution); ECS tasks not registered in Cloud Map. Use a Docker-native alias instead (next row). |
| `bootstrap.sh`-style IP patching | required (~150 lines) | ✅ **ELIMINATED** — replaced by a constant Docker-DNS alias (`nginx-stable`). API GW integration is fixed at `http://nginx-stable/`; `bootstrap.sh` only re-attaches the alias (idempotent, no `docker inspect`, no integration patch, no infra mutation). Verified across a task recreation. |
| API GW v2 local invoke URL | `<api-id>.execute-api.localhost:4566` | **`/restapis/<id>/$default/_user_request_/<path>`** (LocalStack-style) |
| Cognito `iss` claim | `https://cognito-idp.<region>.amazonaws.com/<pool>` | **`http://localhost:4566/<pool-id>`** — authorizer issuer set to match |
| Health / startup | Python healthcheck | Quarkus app, `curl` healthcheck, healthy in ~12s |

## Net assessment

**Pros over Ministack:** modern separate SG-rule resources work; same SDK/endpoint
interface; MIT, no telemetry; clean service list incl. `apigatewayv2`, `cloudmap`,
`elbv2`, `servicediscovery`.

**Eliminated the main pain** (`bootstrap.sh` IP patching): the fragile `docker inspect`
+ `update-integration` step is gone. The API GW integration is fixed at
`http://nginx-stable/`; a constant Docker-DNS alias makes the volatile nginx task
addressable without discovering its IP or mutating infra. Cloud Map/Route53 cannot do
this in Floci (management-plane only), so the Docker-native alias is the mechanism.
This alias pattern is portable to Ministack too (its `bootstrap.sh` does the same IP
patch today), so it is not by itself a Floci-vs-Ministack differentiator.

**New quirks introduced:** the Cognito-client `analytics_configuration` empty-block
bug (needs `ignore_changes`), the different invoke-URL format, and the different
`iss` claim.

**Recommendation:** Floci runs our real local auth chain (PASS), removes a couple of
Ministack quirks (separate SG rules), and — with the stable-DNS-alias pattern — lets
us drop the IP-patch step. Decision on whether to migrate is deferred to the user with
this evidence — not made here. ADR-0012 is unchanged.

## Teardown

```bash
cd infra/environments/local/spike-floci
terraform destroy -auto-approve
docker compose down
```
