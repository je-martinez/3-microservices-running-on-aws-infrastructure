locals {
  region = "us-east-1"
}

# ─── Label instances ───────────────────────────────────────────────────────────
# Each module gets its own label so resource ids differ (e.g. 3mrai-local-net,
# 3mrai-local-aurora, ...). `context` is passed to the resource modules as the
# {id, tags} object each of them expects (NOT module.label.context).
module "label_net" {
  source      = "../../modules/label"
  namespace   = "3mrai"
  environment = var.environment
  name        = "net"
}
module "label_db" {
  source      = "../../modules/label"
  namespace   = "3mrai"
  environment = var.environment
  name        = "aurora"
}
module "label_cognito" {
  source      = "../../modules/label"
  namespace   = "3mrai"
  environment = var.environment
  name        = "cognito"
}
module "label_compute" {
  source      = "../../modules/label"
  namespace   = "3mrai"
  environment = var.environment
  name        = "compute"
}
module "label_api" {
  source      = "../../modules/label"
  namespace   = "3mrai"
  environment = var.environment
  name        = "api"
}

# ─── Networking ─────────────────────────────────────────────────────────────────
# NOTE (reconciliation): the networking module's `subnets` variable is
# list(object({ suffix, cidr, az })), while the root `var.subnets` (Task 1) is a
# plain list(string) of CIDRs — the two are not interchangeable. Rather than
# reshape a Task-1 variable (out of scope for this composition task), `subnets`
# is intentionally omitted here so the module falls back to its own default
# (already shaped correctly: 2 AZs, 10.0.1.0/24 + 10.0.2.0/24). `vpc_cidr` is a
# plain string in both places, so it is passed through.
module "networking" {
  source   = "../../modules/networking"
  context  = { id = module.label_net.id, tags = module.label_net.tags }
  vpc_cidr = var.vpc_cidr
}

# ─── Aurora Postgres ────────────────────────────────────────────────────────────
# RECONCILIATION: the label module's default label_order puts "namespace"
# first, so module.label_db.id = "3mrai-local-aurora" — a digit-leading
# string. rds-aurora interpolates context.id straight into
# aws_rds_cluster.cluster_identifier ("${var.context.id}-aurora"), and AWS/the
# provider rejects identifiers that don't start with a letter. The `infra/modules/label`
# wrapper does not expose `label_order` as a passthrough, so it cannot be
# reordered from here without editing that module (out of scope — compose/wire
# only). Building the context object inline with a letter-led id is pure
# composition: reuses module.label_db.tags as-is, only reshapes id.
module "rds_aurora" {
  source              = "../../modules/rds-aurora"
  context             = { id = "aurora-${module.label_db.id}", tags = module.label_db.tags }
  subnet_ids          = module.networking.subnet_ids
  security_group_ids  = module.networking.security_group_ids
  database_name       = var.db_name
  master_username     = var.db_username
  master_password     = var.db_password
  engine              = "postgres"
  instance_class      = "db.t3.micro"
  skip_final_snapshot = true
  manage_app_user     = true
  create_subnet_group = false
  subnet_group_name   = "default"
}

# ─── Cognito ────────────────────────────────────────────────────────────────────
module "cognito" {
  source       = "../../modules/cognito"
  context      = { id = module.label_cognito.id, tags = module.label_cognito.tags }
  region       = local.region
  issuer_style = "floci"
}

# ─── Compute (ECS cluster + nginx reverse proxy) ────────────────────────────────
# backend_service_name/backend_port point nginx at the real `users` compose
# service (port 3000), per JE-36 decisions.
module "compute" {
  source               = "../../modules/compute"
  context              = { id = module.label_compute.id, tags = module.label_compute.tags }
  vpc_id               = module.networking.vpc_id
  subnet_ids           = module.networking.subnet_ids
  security_group_ids   = module.networking.security_group_ids
  backend_service_name = "users"
  backend_port         = 3000
  region               = local.region
}

# ─── API Gateway ────────────────────────────────────────────────────────────────
# nginx_integration_uri uses the stable Docker-DNS alias (proven in the spike)
# instead of the module's own IP-patch-oriented default/description — the ECS
# task is recreated on every apply, so pinning to a discovered IP would break.
module "api_gateway" {
  source                   = "../../modules/api-gateway"
  context                  = { id = module.label_api.id, tags = module.label_api.tags }
  cognito_issuer           = module.cognito.issuer
  cognito_audience         = module.cognito.client_id
  nginx_integration_uri    = "http://nginx-stable/"
  enable_e2e_cleanup_route = true
}
