# =============================================================================
# environments/local — Users chain on Ministack
#
# Composition order:
#   1. label      — shared naming context for all modules
#   2. networking — VPC, subnets, security group
#   3. rds-aurora — Aurora Postgres writer + reader + credentials secret
#   4. cognito    — User Pool + App Client (JWT authorizer source)
#   5. compute    — ECS Fargate cluster + Nginx reverse-proxy task
#   6. api-gateway— HTTP API + JWT authorizer + routes + nginx integration
#
# Bootstrap requirement (ADR-0016):
#   The Nginx ECS container IP is not known at apply time.  After this apply
#   completes, run `bash bootstrap.sh` which:
#     1. Discovers the Nginx container IP via `docker inspect`.
#     2. Re-applies Terraform with -var nginx_container_ip=<ip> to patch
#        the API Gateway integration URI.
#   Then run the Prisma migration using the database_writer_url output.
# =============================================================================

# ─── 1. Label ─────────────────────────────────────────────────────────────────
module "label" {
  source = "../../modules/label"

  namespace   = "3mrai"
  environment = "local"
  name        = "users"
}

# ─── 2. Networking ────────────────────────────────────────────────────────────
module "networking" {
  source = "../../modules/networking"

  context = {
    id   = module.label.id
    tags = module.label.tags
  }

  vpc_cidr = "10.0.0.0/16"
  subnets = [
    { suffix = "a", cidr = "10.0.1.0/24", az = "us-east-1a" },
    { suffix = "b", cidr = "10.0.2.0/24", az = "us-east-1b" },
  ]
}

# ─── 3. RDS Aurora ────────────────────────────────────────────────────────────
module "rds_aurora" {
  source = "../../modules/rds-aurora"

  context = {
    id   = module.label.id
    tags = module.label.tags
  }

  subnet_ids         = module.networking.subnet_ids
  security_group_ids = module.networking.security_group_ids

  database_name   = "users"
  master_username = "postgres"
  master_password = var.db_master_password

  # Local: skip final snapshot, minimal instance class for Ministack
  skip_final_snapshot = true
  instance_class      = "db.t3.medium"
}

# ─── 4. Cognito ───────────────────────────────────────────────────────────────
module "cognito" {
  source = "../../modules/cognito"

  context = {
    id   = module.label.id
    tags = module.label.tags
  }

  region                  = var.region
  password_minimum_length = 8
}

# ─── 5. Compute (Nginx reverse proxy) ─────────────────────────────────────────
#
# Nginx proxies to the `users` docker-compose service by Docker DNS name.
# The compose service must be running before API GW traffic arrives.
# Docker's embedded DNS (127.0.0.11) resolves `users` from inside the ECS
# task container, which runs on 3mrai_3mrai-network.
module "compute" {
  source = "../../modules/compute"

  context = {
    id   = module.label.id
    tags = module.label.tags
  }

  vpc_id             = module.networking.vpc_id
  subnet_ids         = module.networking.subnet_ids
  security_group_ids = module.networking.security_group_ids

  backend_service_name = "users"
  backend_port         = 3000

  region             = var.region
  cpu                = 256
  memory             = 512
  log_retention_days = 1
}

# ─── 6. API Gateway ───────────────────────────────────────────────────────────
#
# Integration URI:
#   - First apply: placeholder http://0.0.0.0:80/ (nginx IP unknown yet)
#   - After bootstrap.sh: patched to http://<nginx-task-ip>:80/
#
# Issuer: AWS-format URL — Ministack validates tokens against this, NOT localhost.
# Source: docs/lessons/ministack-auth-chain-spike-findings.md, finding #11.
module "api_gateway" {
  source = "../../modules/api-gateway"

  context = {
    id   = module.label.id
    tags = module.label.tags
  }

  cognito_issuer   = module.cognito.issuer
  cognito_audience = module.cognito.client_id

  # Placeholder replaced by bootstrap.sh once the Nginx container IP is known.
  nginx_integration_uri = var.nginx_container_ip != "" ? "http://${var.nginx_container_ip}:80/" : "http://0.0.0.0:80/"

  enable_e2e_cleanup_route = true
}
