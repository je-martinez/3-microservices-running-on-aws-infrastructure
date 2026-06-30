# Floci Local Emulator Spike — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate empirically whether Floci can run the 3MRAI local auth chain (Cognito JWT → API GW v2 → ECS Nginx → spike-backend) and whether DNS service discovery (Cloud Map/Route53) can eliminate the fragile `bootstrap.sh` IP-patching — A/B against the existing Ministack spike, with zero commits until a positive result is approved.

**Architecture:** A new parallel Terraform stack `infra/environments/local/spike-floci/` (adapted from `spike/`) targets Floci on `:4566`. A `docker-compose.floci.yml` runs `floci` + `spike-backend`. Floci joins its ECS containers to `3mrai-network` so Nginx resolves `spike-backend` by `container_name`. The API GW integration targets a Cloud Map DNS name (ideal) or falls back to IP discovery (documented).

**Tech Stack:** Floci (`floci/floci:latest`), Terraform (modern `hashicorp/aws` provider, unpinned), AWS CLI v2, Docker Compose, nginx:alpine, hashicorp/http-echo.

## Global Constraints

- **NO COMMITS.** This is an exploratory spike. Everything stays in the working tree. Nothing is committed until the spike produces a clear/positive result and the user approves it. Steps that would normally commit instead **capture findings** in `spike-floci/README.md`.
- **Zero risk to existing work.** Do NOT modify `infra/environments/local/spike/` or `infra/environments/local/*.tf`. The only edit to existing files is commenting out the `ministack` service in `docker-compose.yml`.
- **Converse in Spanish; write config/comments/docs in English** (per repo CLAUDE.md).
- **Node via nvm:** run `nvm use` before any `node`/`pnpm`/`npx` (pinned 24.18.0). Not needed for terraform/docker/aws-cli steps.
- **Route53/Cloud Map-first with documented fallback.** Attempt DNS service discovery first; if Floci lacks a piece, fall back to the known pattern (IP / `container_name`) and record the gap as a finding — do not block the spike.
- **No ADR changes.** ADR-0012 stays `accepted`; no new Floci ADR in this plan.
- Floci listens on container `:4566`; map host `:4566` (Ministack is down, port is free).
- Compose network name: project `3mrai` → network `3mrai-network` → Docker network `3mrai_3mrai-network` (this is the value for `FLOCI_SERVICES_ECS_DOCKER_NETWORK`).

---

> **Update (2026-06-29):** the `docker-compose.floci.yml` overlay described below was later consolidated into the root `docker-compose.yml` — the `floci` and `spike-backend` services now live there (below the commented-out `ministack` block). Run with `docker compose up -d floci spike-backend` (no `-f` overlay flags). References to `docker-compose.floci.yml` in the tasks below reflect the original plan, not the final layout.

---

## File Structure

```
docker-compose.yml                          # MODIFY: comment out `ministack` service only
docker-compose.floci.yml                    # NEW: `floci` (:4566, ECS→3mrai network) + spike-backend
infra/environments/local/spike-floci/       # NEW Terraform stack
  ├── terraform.tf                          #   required_providers (modern aws, unpinned)
  ├── providers.tf                          #   aws provider → :4566, LocalStack-compat flags
  ├── main.tf                               #   cognito + iam + networking + ecs nginx
  │                                         #     + cloud map + api-gw
  ├── variables.tf
  ├── outputs.tf
  ├── README.md                             #   topology, how-to-run, FINDINGS table
  └── smoke-test.sh                          #   401/200 chain + DNS verification
```

---

### Task 1: Compose — Floci service + spike-backend, Ministack commented out

**Files:**
- Modify: `docker-compose.yml` (comment out the `ministack` service block only)
- Create: `docker-compose.floci.yml`

**Interfaces:**
- Produces: a running `floci` container on host `:4566`, joined to network `3mrai-network`; ECS tasks launched by Floci join `3mrai_3mrai-network` via `FLOCI_SERVICES_ECS_DOCKER_NETWORK`; a `spike-backend` container with `container_name: spike-backend` returning `spike-ok-via-floci` on `:8080`.

- [ ] **Step 1: Comment out the `ministack` service in `docker-compose.yml`**

Wrap the entire `ministack:` service block (lines ~20–43, from `  ministack:` through its `retries: 3`) in comments, and add a one-line note. Do NOT delete it. Leave the `spike-backend`, `users`, `orders`, `tracking`, `events-pipeline` services and the `3mrai-network` network untouched.

Prepend this note directly above the commented block:

```yaml
  # ── Ministack DISABLED for the Floci spike (2026-06-29) ──────────────────────
  # Superseded locally by docker-compose.floci.yml (`floci` on :4566). Kept
  # commented (not deleted) so we can revert if the Floci spike does not pass.
  # See docs/superpowers/specs/2026-06-29-floci-local-emulator-spike-design.md
  # ministack:
  #   image: ministackorg/ministack:1.3.69-full
  #   ... (rest of the block commented) ...
```

- [ ] **Step 2: Create `docker-compose.floci.yml`**

```yaml
# 3MRAI Floci spike overlay (2026-06-29).
# Run WITH the base compose file:
#   docker compose -f docker-compose.yml -f docker-compose.floci.yml up -d floci spike-backend
#
# Floci emulates AWS locally on :4566 (same interface as Ministack). It launches
# ECS tasks as real Docker containers and joins them to the compose network named
# here via FLOCI_SERVICES_ECS_DOCKER_NETWORK, so the Nginx ECS task resolves the
# `spike-backend` container by name through Docker DNS.
name: 3mrai

services:
  floci:
    image: floci/floci:latest
    ports:
      - "4566:4566"
    environment:
      # ECS tasks launched by Floci join the compose network and can resolve
      # other compose containers (spike-backend) by container_name via Docker DNS.
      - FLOCI_SERVICES_ECS_DOCKER_NETWORK=3mrai_3mrai-network
      # Persist state across restarts under ./data/floci (git-ignored).
      - FLOCI_STORAGE_MODE=persistent
      - FLOCI_STORAGE_PERSISTENT_PATH=/app/data
    volumes:
      - ./data/floci:/app/data
      - /var/run/docker.sock:/var/run/docker.sock
    networks: [3mrai-network]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:4566/"]
      interval: 10s
      timeout: 3s
      retries: 5

  # Spike backend: proves traffic traversed the full chain.
  # container_name fixes the Docker DNS name the Nginx ECS task proxies to.
  spike-backend:
    image: hashicorp/http-echo:latest
    container_name: spike-backend
    command: ["-listen=:8080", "-text=spike-ok-via-floci"]
    networks: [3mrai-network]
```

- [ ] **Step 3: Bring Floci up and verify health**

```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
mkdir -p data/floci
docker compose -f docker-compose.yml -f docker-compose.floci.yml up -d floci spike-backend
sleep 8
docker compose -f docker-compose.yml -f docker-compose.floci.yml ps
curl -s -o /dev/null -w "floci HTTP %{http_code}\n" http://localhost:4566/
```
Expected: `floci` and `spike-backend` are `Up`; `floci HTTP 200` (or any non-000 response proving the port answers).

- [ ] **Step 4: Verify the AWS interface answers (sts)**

```bash
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
aws --endpoint-url=http://localhost:4566 --region us-east-1 sts get-caller-identity
```
Expected: a JSON identity (Account `000000000000` or similar). If it errors, capture the error — it tells us how Floci differs from Ministack.

- [ ] **Step 5: Capture finding (NO COMMIT)**

Note in a scratch list (to seed `spike-floci/README.md` later): does Floci come up healthy? Does `sts get-caller-identity` work? Record exact output.

---

### Task 2: Terraform skeleton — providers (modern, unpinned) + smoke `apply`

**Files:**
- Create: `infra/environments/local/spike-floci/terraform.tf`
- Create: `infra/environments/local/spike-floci/providers.tf`
- Create: `infra/environments/local/spike-floci/variables.tf`
- Create: `infra/environments/local/spike-floci/main.tf` (Cognito only, this task)
- Create: `infra/environments/local/spike-floci/outputs.tf` (Cognito outputs, this task)

**Interfaces:**
- Produces: a working `terraform init`/`apply` against Floci with a **modern unpinned** AWS provider, and a Cognito user pool + client. This task isolates the biggest unknown (does Floci tolerate a modern provider?) before building the rest.

- [ ] **Step 1: Write `terraform.tf` with an UNPINNED modern provider**

```hcl
terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Floci spike: intentionally UNPINNED (latest 5.x) to test whether Floci
      # tolerates a modern provider. Ministack required pinning to 5.31.0 because
      # v5.100 nil-pointer-panicked. If Floci also crashes, pin here and record
      # the finding in README.md.
      version = "~> 5.0"
    }
  }
}
```

- [ ] **Step 2: Write `providers.tf` targeting Floci on :4566**

```hcl
provider "aws" {
  region     = "us-east-1"
  access_key = "test"
  secret_key = "test"

  # LocalStack/Floci compatibility flags (same family as Ministack).
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  # Every service used by this stack must be declared, else Terraform calls real
  # AWS. servicediscovery (Cloud Map) and route53 are included for the DNS-first
  # approach this spike validates.
  endpoints {
    apigateway       = "http://localhost:4566"
    apigatewayv2     = "http://localhost:4566"
    cognitoidp       = "http://localhost:4566"
    ec2              = "http://localhost:4566"
    ecs              = "http://localhost:4566"
    elbv2            = "http://localhost:4566"
    iam              = "http://localhost:4566"
    logs             = "http://localhost:4566"
    route53          = "http://localhost:4566"
    servicediscovery = "http://localhost:4566"
    sts              = "http://localhost:4566"
  }
}
```

- [ ] **Step 3: Write `variables.tf`**

```hcl
variable "spike_backend_port" {
  description = "Port where spike-backend (hashicorp/http-echo) listens on 3mrai-network."
  type        = number
  default     = 8080
}

variable "nginx_integration_fallback" {
  description = "Fallback integration URI used only if Cloud Map DNS resolution is not usable by Floci's API GW. smoke-test.sh patches the real value (Cloud Map name or container IP). Placeholder is clearly invalid so a misconfig is obvious."
  type        = string
  default     = "0.0.0.0:80"
}
```

- [ ] **Step 4: Write `main.tf` with Cognito only (rest added in later tasks)**

```hcl
# ============================================================
# Floci auth-chain spike — adapted from infra/environments/local/spike/main.tf
# Validates: Cognito JWT → API GW v2 → ECS Nginx → spike-backend, on Floci.
# Built incrementally; this file grows per task. NO module usage (self-contained
# spike, mirrors the Ministack spike layout for a clean A/B comparison).
# ============================================================

# ── Cognito ─────────────────────────────────────────────────
resource "aws_cognito_user_pool" "spike" {
  name = "3mrai-local-floci-spike"

  password_policy {
    minimum_length    = 8
    require_lowercase = false
    require_numbers   = false
    require_symbols   = false
    require_uppercase = false
  }
}

resource "aws_cognito_user_pool_client" "spike" {
  name         = "3mrai-local-floci-spike-client"
  user_pool_id = aws_cognito_user_pool.spike.id

  explicit_auth_flows = [
    "ALLOW_ADMIN_USER_PASSWORD_AUTH",
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = false
}
```

- [ ] **Step 5: Write `outputs.tf` (Cognito only this task)**

```hcl
output "cognito_user_pool_id" {
  description = "Cognito User Pool ID used by the JWT authorizer."
  value       = aws_cognito_user_pool.spike.id
}

output "cognito_client_id" {
  description = "Cognito App Client ID (JWT audience)."
  value       = aws_cognito_user_pool_client.spike.id
}

output "jwt_issuer" {
  description = "Issuer URL for the JWT authorizer (must match the iss claim Floci puts in IdTokens — verify empirically; may differ from Ministack)."
  value       = "https://cognito-idp.us-east-1.amazonaws.com/${aws_cognito_user_pool.spike.id}"
}
```

- [ ] **Step 6: init + apply, verify modern provider works against Floci**

```bash
cd infra/environments/local/spike-floci
terraform init
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
  terraform apply -auto-approve
terraform output cognito_user_pool_id
```
Expected: apply succeeds; a Cognito pool ID is printed.
**Decision point:** if apply crashes with a provider panic, pin `aws` to `= 5.31.0` in `terraform.tf`, re-run, and record "modern provider NOT supported" in the findings list. If it succeeds, record "modern provider OK — pin removed".

- [ ] **Step 7: Capture finding (NO COMMIT)**

Record: modern provider OK/needs-pin; the real `iss` claim Floci issues (we verify this in Task 5 when minting a token).

---

### Task 3: Networking + IAM + ECS Nginx (no DNS yet)

**Files:**
- Modify: `infra/environments/local/spike-floci/main.tf` (append networking, IAM, ECS)
- Modify: `infra/environments/local/spike-floci/outputs.tf` (append ECS cluster name)

**Interfaces:**
- Consumes: `var.spike_backend_port`.
- Produces: `aws_ecs_cluster.spike` (name `3mrai-local-floci-spike-cluster`), `aws_ecs_service.spike_nginx` (name `3mrai-local-floci-spike-nginx`) running an nginx:alpine task on `3mrai_3mrai-network` that proxies to `spike-backend:8080`.

- [ ] **Step 1: Test separate SG rule resources first (Ministack needed inline)**

Append to `main.tf`. Try the **separate** `aws_vpc_security_group_*_rule` resources (the modern idiom Ministack couldn't handle) — this is a quirk we want to eliminate:

```hcl
# ── IAM — ECS task execution role ───────────────────────────
resource "aws_iam_role" "spike_ecs_execution" {
  name = "3mrai-local-floci-spike-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "spike_ecs_execution_policy" {
  role       = aws_iam_role.spike_ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ── Networking ──────────────────────────────────────────────
resource "aws_vpc" "spike" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "3mrai-local-floci-spike-vpc" }
}

resource "aws_subnet" "spike_a" {
  vpc_id                  = aws_vpc.spike.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "us-east-1a"
  map_public_ip_on_launch = true
  tags                    = { Name = "3mrai-local-floci-spike-subnet-a" }
}

resource "aws_subnet" "spike_b" {
  vpc_id                  = aws_vpc.spike.id
  cidr_block              = "10.0.2.0/24"
  availability_zone       = "us-east-1b"
  map_public_ip_on_launch = true
  tags                    = { Name = "3mrai-local-floci-spike-subnet-b" }
}

resource "aws_security_group" "spike" {
  name        = "3mrai-local-floci-spike-sg"
  description = "Allow all traffic for the Floci spike"
  vpc_id      = aws_vpc.spike.id
  tags        = { Name = "3mrai-local-floci-spike-sg" }
}

# Floci spike: try the SEPARATE rule resources (Ministack crashed on these and
# forced inline ingress/egress). If Floci also fails, replace these two resources
# with inline `ingress {}`/`egress {}` blocks in the SG above and record the finding.
resource "aws_vpc_security_group_ingress_rule" "spike_all" {
  security_group_id = aws_security_group.spike.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_egress_rule" "spike_all" {
  security_group_id = aws_security_group.spike.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# ── ECS — Nginx reverse proxy ───────────────────────────────
resource "aws_ecs_cluster" "spike" {
  name = "3mrai-local-floci-spike-cluster"
  tags = { Name = "3mrai-local-floci-spike-cluster" }
}

resource "aws_cloudwatch_log_group" "spike" {
  name              = "/ecs/3mrai-local-floci-spike"
  retention_in_days = 1
}

resource "aws_ecs_task_definition" "spike_nginx" {
  family                   = "3mrai-local-floci-spike-nginx"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.spike_ecs_execution.arn

  container_definitions = jsonencode([{
    name      = "nginx"
    image     = "nginx:alpine"
    essential = true

    portMappings = [{ containerPort = 80, hostPort = 80, protocol = "tcp" }]

    # Write nginx.conf at start, then exec nginx. resolver 127.0.0.11 is Docker's
    # embedded DNS; `set $backend` forces per-request resolution of spike-backend
    # (resolved by container_name on 3mrai_3mrai-network).
    command = [
      "sh", "-c",
      join(" && ", [
        "printf 'server {\\n  listen 80;\\n  location / {\\n    resolver 127.0.0.11 valid=5s;\\n    set $backend spike-backend;\\n    proxy_pass http://$backend:${var.spike_backend_port};\\n    proxy_set_header Host $host;\\n    proxy_set_header X-Real-IP $remote_addr;\\n  }\\n}\\n' > /etc/nginx/conf.d/default.conf",
        "nginx -g 'daemon off;'"
      ])
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.spike.name
        "awslogs-region"        = "us-east-1"
        "awslogs-stream-prefix" = "nginx"
      }
    }
  }])
}

resource "aws_ecs_service" "spike_nginx" {
  name            = "3mrai-local-floci-spike-nginx"
  cluster         = aws_ecs_cluster.spike.id
  task_definition = aws_ecs_task_definition.spike_nginx.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [aws_subnet.spike_a.id, aws_subnet.spike_b.id]
    security_groups  = [aws_security_group.spike.id]
    assign_public_ip = true
  }

  depends_on = [aws_iam_role_policy_attachment.spike_ecs_execution_policy]
}
```

- [ ] **Step 2: Append ECS cluster name to `outputs.tf`**

```hcl
output "ecs_cluster_name" {
  description = "ECS cluster name (used by smoke-test.sh to locate the Nginx container)."
  value       = aws_ecs_cluster.spike.name
}
```

- [ ] **Step 3: apply and verify the Nginx ECS task launches as a Docker container**

```bash
cd infra/environments/local/spike-floci
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
  terraform apply -auto-approve
sleep 10
docker ps --format '{{.Names}}\t{{.Networks}}' | grep -i nginx
```
Expected: apply succeeds; a Floci-launched nginx container appears, joined to `3mrai_3mrai-network`.
**Decision point:** if `aws_vpc_security_group_*_rule` errors, switch to inline rules and record the finding. If no nginx container launches, check `docker logs <floci-container>` and record whether `FLOCI_SERVICES_ECS_DOCKER_NETWORK` worked.

- [ ] **Step 4: Verify Docker DNS — Nginx resolves spike-backend by container_name**

```bash
NGINX=$(docker ps --format '{{.Names}}' | grep -i nginx | head -1)
docker exec "$NGINX" sh -c 'wget -qO- http://spike-backend:8080/ || echo FAILED'
```
Expected: `spike-ok-via-floci`. This proves the cross-network Docker DNS resolution works (the core thing the chain depends on).
**Decision point:** if it prints FAILED, the `FLOCI_SERVICES_ECS_DOCKER_NETWORK` value is wrong or the network differs — inspect `docker network ls` and the nginx container's networks, fix, record finding.

- [ ] **Step 5: Capture findings (NO COMMIT)**

Record: separate-SG-rules OK/needs-inline; ECS-on-compose-network OK; Docker DNS to `spike-backend` OK.

---

### Task 4: Cloud Map DNS + API Gateway (DNS-first, IP fallback)

**Files:**
- Modify: `infra/environments/local/spike-floci/main.tf` (append Cloud Map + API GW)
- Modify: `infra/environments/local/spike-floci/outputs.tf` (append API/integration outputs)

**Interfaces:**
- Consumes: `aws_ecs_cluster.spike`, `aws_ecs_service.spike_nginx`, `aws_cognito_user_pool_client.spike`, `aws_cognito_user_pool.spike`, `var.nginx_integration_fallback`.
- Produces: `aws_apigatewayv2_api.spike` with routes `GET /protected` (JWT) and `GET /public` (open); integration `aws_apigatewayv2_integration.spike_nginx`; a Cloud Map service whose DNS name is the integration target (ideal path). Outputs: `api_id`, `nginx_integration_id`, `cloudmap_service_name`.

- [ ] **Step 1: Append Cloud Map (service discovery) — DNS-first attempt**

```hcl
# ── Cloud Map (service discovery) — DNS-first ───────────────
# Goal: give the Nginx ECS service a STABLE DNS name so the API GW integration
# URI is known at apply time — eliminating the docker-inspect/IP-patch bootstrap.
# If Floci does not support servicediscovery or the ECS service registration,
# the smoke-test falls back to IP discovery and we record the gap.
resource "aws_service_discovery_private_dns_namespace" "spike" {
  name = "spike.local"
  vpc  = aws_vpc.spike.id
}

resource "aws_service_discovery_service" "nginx" {
  name = "nginx"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.spike.id
    dns_records {
      type = "A"
      ttl  = 10
    }
    routing_policy = "MULTIVALUE"
  }
}
```

Then wire the ECS service to register in Cloud Map by adding a `service_registries` block to `aws_ecs_service.spike_nginx` (modify the resource from Task 3):

```hcl
  service_registries {
    registry_arn = aws_service_discovery_service.nginx.arn
  }
```

- [ ] **Step 2: Append API Gateway v2 + JWT authorizer + integration + routes**

The integration URI uses the Cloud Map DNS name `nginx.spike.local` (ideal). `smoke-test.sh` re-patches it if Floci needs an IP.

```hcl
# ── API Gateway v2 (HTTP) + JWT authorizer ──────────────────
resource "aws_apigatewayv2_api" "spike" {
  name          = "3mrai-local-floci-spike-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_authorizer" "spike" {
  api_id           = aws_apigatewayv2_api.spike.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "3mrai-local-floci-spike-jwt"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.spike.id]
    # Must match the iss claim Floci puts in IdTokens. Verified empirically in
    # Task 5; if Floci uses a different issuer, update this and record it.
    issuer = "https://cognito-idp.us-east-1.amazonaws.com/${aws_cognito_user_pool.spike.id}"
  }
}

resource "aws_apigatewayv2_integration" "spike_nginx" {
  api_id             = aws_apigatewayv2_api.spike.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  connection_type    = "INTERNET"

  # DNS-first: target the stable Cloud Map name. smoke-test.sh patches this to a
  # container IP only if Floci's API GW cannot resolve the Cloud Map name.
  integration_uri = "http://nginx.spike.local/"
}

resource "aws_apigatewayv2_route" "spike_protected" {
  api_id             = aws_apigatewayv2_api.spike.id
  route_key          = "GET /protected"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.spike.id
  target             = "integrations/${aws_apigatewayv2_integration.spike_nginx.id}"
}

resource "aws_apigatewayv2_route" "spike_public" {
  api_id             = aws_apigatewayv2_api.spike.id
  route_key          = "GET /public"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.spike_nginx.id}"
}

resource "aws_apigatewayv2_stage" "spike" {
  api_id      = aws_apigatewayv2_api.spike.id
  name        = "$default"
  auto_deploy = true
}
```

- [ ] **Step 3: Append API/integration/cloudmap outputs to `outputs.tf`**

```hcl
output "api_id" {
  description = "API Gateway v2 API ID. Local invoke URL: http://<api_id>.execute-api.localhost:4566"
  value       = aws_apigatewayv2_api.spike.id
}

output "nginx_integration_id" {
  description = "API GW integration ID; smoke-test.sh patches its URI if Cloud Map DNS is not resolvable by Floci's API GW."
  value       = aws_apigatewayv2_integration.spike_nginx.id
}

output "cloudmap_service_name" {
  description = "Cloud Map DNS name targeted by the integration (nginx.spike.local)."
  value       = "nginx.spike.local"
}
```

- [ ] **Step 4: apply and verify (Cloud Map may or may not be supported)**

```bash
cd infra/environments/local/spike-floci
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
  terraform apply -auto-approve
terraform output api_id
```
Expected: apply succeeds. **Decision point:** if `aws_service_discovery_*` errors (Floci lacks servicediscovery), remove the Cloud Map resources + the `service_registries` block, set the integration URI to `http://${var.nginx_integration_fallback}/`, re-apply, and record "Cloud Map NOT supported — bootstrap.sh-style IP patch still required". This is a key A/B finding.

- [ ] **Step 5: Capture findings (NO COMMIT)**

Record: Cloud Map supported? ECS service registration OK? Does the API GW accept a DNS integration URI?

---

### Task 5: Smoke test — the 401/200 gate + findings capture

**Files:**
- Create: `infra/environments/local/spike-floci/smoke-test.sh`

**Interfaces:**
- Consumes: terraform outputs `api_id`, `cognito_user_pool_id`, `cognito_client_id`, `nginx_integration_id`, `ecs_cluster_name`, `cloudmap_service_name`.
- Produces: a PASS/FAIL verdict for the chain; exit 0 = PASS.

- [ ] **Step 1: Write `smoke-test.sh`**

```bash
#!/usr/bin/env bash
# smoke-test.sh — Floci auth-chain spike gate.
#
# Validates: Cognito JWT → API GW v2 JWT authorizer → ECS Nginx → spike-backend.
# PASS when: GET /protected (no token) → 401, and GET /protected (Bearer) → 200
# with body "spike-ok-via-floci".
#
# DNS-first: if the Cloud Map name (nginx.spike.local) is resolvable by Floci's
# API GW, NO IP patching is needed (the win over Ministack's bootstrap.sh). If
# the authenticated call fails because the integration cannot resolve the name,
# the script falls back to discovering the Nginx container IP and patches the
# integration URI — and prints a clear "FALLBACK USED" warning so the finding
# is captured.
set -euo pipefail

ENDPOINT="http://localhost:4566"
REGION="us-east-1"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION="$REGION"
AWS="aws --endpoint-url=$ENDPOINT --region=$REGION --no-cli-pager"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; N='\033[0m'
pass(){ echo -e "  ${G}PASS${N}: $1"; }
fail(){ echo -e "  ${R}FAIL${N}: $1"; exit 1; }
warn(){ echo -e "  ${Y}WARN${N}: $1"; }

API_ID=$(terraform -chdir="$HERE" output -raw api_id)
POOL_ID=$(terraform -chdir="$HERE" output -raw cognito_user_pool_id)
CLIENT_ID=$(terraform -chdir="$HERE" output -raw cognito_client_id)
INTEG_ID=$(terraform -chdir="$HERE" output -raw nginx_integration_id)
INVOKE="http://${API_ID}.execute-api.localhost:4566"

echo "API: $INVOKE"

# 1. Cognito test user + authenticate
USER="spikeuser@example.com"; PASS_W="SpikePass123"
$AWS cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username "$USER" \
  --message-action SUPPRESS >/dev/null 2>&1 || true
$AWS cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" --username "$USER" \
  --password "$PASS_W" --permanent >/dev/null 2>&1 || true
TOKEN=$($AWS cognito-idp admin-initiate-auth --user-pool-id "$POOL_ID" \
  --client-id "$CLIENT_ID" --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters "USERNAME=$USER,PASSWORD=$PASS_W" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['AuthenticationResult']['IdToken'])")
[ -n "$TOKEN" ] && pass "Cognito IdToken minted" || fail "could not mint IdToken"

# (Finding) print the iss claim Floci actually issues
echo "$TOKEN" | cut -d. -f2 | python3 -c "import sys,base64,json;d=sys.stdin.read();d+='='*(-len(d)%4);print('  iss:',json.loads(base64.urlsafe_b64decode(d)).get('iss'))" || true

# 2. Unauthenticated → expect 401
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$INVOKE/protected" || echo 000)
[ "$CODE" = "401" ] && pass "GET /protected (no token) → 401" || warn "expected 401, got $CODE"

# 3. Authenticated → expect 200 + body
BODY=$(curl -s --max-time 15 -H "Authorization: Bearer $TOKEN" "$INVOKE/protected" || true)
if echo "$BODY" | grep -q "spike-ok-via-floci"; then
  pass "GET /protected (Bearer) → 200 body=spike-ok-via-floci [DNS-first, NO bootstrap]"
  echo -e "\n  ${G}GATE VERDICT: PASS (ideal — no IP patching needed)${N}"
  exit 0
fi

# 4. Fallback — patch integration to the Nginx container IP, retry
warn "Authenticated call did not return expected body (got: '${BODY:0:80}'). Trying IP fallback…"
NGINX=$(docker ps --format '{{.ID}} {{.Names}}' | grep -i nginx | head -1 | awk '{print $1}')
[ -n "$NGINX" ] || fail "no nginx container found for fallback"
IP=$(docker inspect "$NGINX" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' | tr ' ' '\n' | grep -v '^$' | head -1)
$AWS apigatewayv2 update-integration --api-id "$API_ID" --integration-id "$INTEG_ID" \
  --integration-uri "http://${IP}:80/" >/dev/null
sleep 3
BODY=$(curl -s --max-time 15 -H "Authorization: Bearer $TOKEN" "$INVOKE/protected" || true)
if echo "$BODY" | grep -q "spike-ok-via-floci"; then
  warn "FALLBACK USED: Cloud Map DNS not resolvable by API GW; IP patch required (like Ministack's bootstrap.sh)."
  echo -e "\n  ${G}GATE VERDICT: PASS (functional — but bootstrap.sh-style IP patch still needed)${N}"
  exit 0
fi
fail "GATE VERDICT: FAIL — chain not working even with IP fallback. Body: '${BODY:0:120}'"
```

- [ ] **Step 2: Make it executable and run it**

```bash
chmod +x infra/environments/local/spike-floci/smoke-test.sh
bash infra/environments/local/spike-floci/smoke-test.sh
```
Expected: a `GATE VERDICT: PASS` line (ideal or functional). If FAIL, the printed body + the per-step PASS/WARN lines tell us exactly where the chain broke.

- [ ] **Step 3: Capture the full findings into README (NO COMMIT)**

Proceed to Task 6 with the verdict + all per-task findings collected.

---

### Task 6: Spike README — topology, how-to-run, and the A/B findings table

**Files:**
- Create: `infra/environments/local/spike-floci/README.md`

**Interfaces:**
- Produces: the human-readable record of what the spike proved, mirroring `spike/README.md` so the A/B is easy to compare.

- [ ] **Step 1: Write `README.md`**

Include: title + date; the architecture diagram (same as `spike/README.md` but `spike-ok-via-floci`); a "How to run" section (compose overlay command, `terraform apply`, `smoke-test.sh`); and the **FINDINGS table** filled from every Decision point in Tasks 1–5:

```markdown
# Floci auth-chain spike

Validates the local auth chain on **Floci** (A/B vs the Ministack spike).

## How to run
1. `docker compose -f docker-compose.yml -f docker-compose.floci.yml up -d floci spike-backend`
2. `cd infra/environments/local/spike-floci && terraform init && terraform apply -auto-approve`
3. `bash smoke-test.sh`

## Findings — Floci vs Ministack

| Concern | Ministack | Floci (this spike) |
|---|---|---|
| AWS provider version | pinned `5.31.0` (v5.100 panics) | <FILL: modern OK / needs pin> |
| Separate SG rule resources | crash → inline required | <FILL> |
| ALB `ip` target | unsupported → Nginx ECS | <FILL — kept Nginx?> |
| ECS on compose network | `LAMBDA_DOCKER_NETWORK` | `FLOCI_SERVICES_ECS_DOCKER_NETWORK` — <FILL OK?> |
| Docker DNS to backend by name | works | <FILL> |
| Cloud Map / Route53 DNS | not used (IP patch) | <FILL — supported? eliminates bootstrap.sh?> |
| `bootstrap.sh` IP patching | required (~150 lines) | <FILL — eliminated / still needed> |
| Cognito iss claim | `cognito-idp.us-east-1…/<pool>` | <FILL — same?> |

## Gate verdict
<FILL: PASS (ideal) / PASS (functional, IP patch) / FAIL> — <one-line rationale>
```

- [ ] **Step 2: Fill every `<FILL>` from the captured findings**

Replace each `<FILL>` with the actual observed result from the apply/smoke runs.

- [ ] **Step 3: Present results to the user — STOP (NO COMMIT)**

Summarize the gate verdict and the findings table in Spanish. Do NOT commit. Ask the user whether the result is positive enough to approve the spike (and only then discuss committing + writing the `floci` skill).

---

## Self-Review

**Spec coverage:**
- A/B parallel spike, zero risk → Tasks 1–4 (new files only; only edit is commenting `ministack`). ✓
- Same auth chain → Tasks 2–5. ✓
- Route53/Cloud Map-first + fallback → Task 4 (Cloud Map) + Task 5 (IP fallback). ✓
- Eliminate `bootstrap.sh` → Task 4 DNS integration + Task 5 verdict (ideal vs functional). ✓
- Quirk elimination (provider pin, SG rules) → Task 2 Step 6, Task 3 Step 1, with fallbacks. ✓
- No RDS / no real services (YAGNI) → not present. ✓
- No ADR changes; skill written AFTER spike → skill is intentionally NOT in this plan; Task 6 Step 3 gates it on approval. ✓
- NO COMMITS → Global Constraints + every task ends in "capture findings (NO COMMIT)"; Task 6 Step 3 stops for approval. ✓

**Placeholder scan:** The `<FILL>` markers in Task 6 are intentional output slots filled at runtime from observed results, not plan placeholders — every step that writes code shows the full code. ✓

**Type/name consistency:** Resource names (`aws_ecs_service.spike_nginx`, `aws_apigatewayv2_integration.spike_nginx`), outputs (`api_id`, `nginx_integration_id`, `cognito_user_pool_id`, `cognito_client_id`, `ecs_cluster_name`, `cloudmap_service_name`), and the network value `3mrai_3mrai-network` are consistent across Tasks 1–6 and the smoke test. ✓

## Related
- Spec: [[2026-06-29-floci-local-emulator-spike-design]]
- [[ADR-0012-ministack-local]]
- [[ministack-auth-chain-spike-findings]]
