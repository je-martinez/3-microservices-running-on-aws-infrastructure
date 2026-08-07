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
module "label_events" {
  source      = "../../modules/label"
  namespace   = "3mrai"
  environment = var.environment
  name        = "events"
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
  # false LOCAL ONLY: the module's postgresql_* resources require the
  # `postgresql` provider to be configured with the cluster's endpoint, but
  # Terraform configures providers BEFORE creating the resources in the plan —
  # the Floci-proxied Postgres endpoint doesn't exist yet on a clean apply, so
  # no host/port default can ever be correct (chicken-and-egg). The
  # least-privilege app DB user is created post-apply instead by
  # bootstrap.sh, which connects to the endpoint once it actually exists.
  # Production keeps manage_app_user = true (stable, pre-existing Aurora DNS
  # endpoint — no chicken-and-egg there).
  manage_app_user     = false
  create_subnet_group = false
  subnet_group_name   = "default"
}

# ─── Orders MySQL label ─────────────────────────────────────────────────────────
module "label_orders_db" {
  source      = "../../modules/label"
  namespace   = "3mrai"
  environment = var.environment
  name        = "orders-db"
}

# ─── Orders MySQL ───────────────────────────────────────────────────────────────
# Second instantiation of the engine-agnostic rds-aurora module, this time with
# engine = "mysql" for the Orders service. Floci runs a real mysql container off
# the cluster alone (no Aurora cluster-instance concept), so the module's
# writer/reader cluster_instances auto-skip via their startswith(engine,"aurora")
# gate — same as the local Postgres above.
#
# Same letter-led-id trick as rds_aurora: module.label_orders_db.id is
# "3mrai-local-orders-db" (digit-leading), and rds-aurora interpolates
# context.id into cluster_identifier which AWS rejects unless it starts with a
# letter — so prefix with "mysql-".
#
# manage_app_user = false LOCAL ONLY: the mysql provider would need the cluster
# endpoint before the cluster exists (chicken-and-egg, same as Postgres). The
# least-privilege orders_app user is created post-apply by bootstrap.sh instead.
module "rds_mysql" {
  source              = "../../modules/rds-aurora"
  context             = { id = "mysql-${module.label_orders_db.id}", tags = module.label_orders_db.tags }
  subnet_ids          = module.networking.subnet_ids
  security_group_ids  = module.networking.security_group_ids
  database_name       = "orders"
  master_username     = var.db_username
  master_password     = var.db_password
  engine              = "mysql"
  engine_version      = "8.0"
  instance_class      = "db.t3.micro"
  skip_final_snapshot = true
  manage_app_user     = false
  create_subnet_group = false
  subnet_group_name   = "default"
}

# ─── Tracking database (SECOND schema on the SAME MySQL cluster) ────────────────
# DECISION: Tracking gets its own database/schema on the EXISTING rds_mysql
# cluster above — NOT a second MySQL cluster.
#
# WHY NOT A SECOND CLUSTER: Floci assigns its RDS proxy ports (7000-7099) by
# cluster CREATION ORDER, and that order is NOT stable across applies — with two
# clusters today (Users Postgres + Orders MySQL) the assignment already flips
# between applies, which is why every consumer must call discover_port(engine).
# `discover_port` resolves a port by matching the cluster's `Engine` field, so a
# THIRD cluster with engine = "mysql" would make that lookup ambiguous: two
# clusters would match "mysql" and the helper would return whichever came first,
# non-deterministically. Disambiguating would mean threading cluster identifiers
# through every caller (Makefile, generator, gate) for zero benefit — Tracking
# and Orders have no cross-schema queries and no independent scaling story
# locally. One cluster, two databases.
#
# MECHANISM: `aws_rds_cluster.database_name` creates exactly ONE database, at
# cluster-creation time (that is how `orders` exists). There is no AWS API — and
# so no Terraform AWS resource — for adding a database to an existing cluster;
# it is engine DDL. The petoju/mysql provider's `mysql_database` is not an option
# either: it needs the cluster endpoint configured BEFORE the cluster exists
# (the same chicken-and-egg that forced manage_app_user = false), and it hangs
# against Floci. So this uses the repo's established awscli-fallback shape
# (terraform_data + local-exec + idempotent Python), which runs after the
# cluster resource. See scripts/create_mysql_database.py for why the DDL must
# run as root rather than as `test`.
resource "terraform_data" "tracking_database" {
  # cluster_identifier is in `input` purely to make this resource DEPEND on the
  # cluster: terraform_data replaces when `input` changes, so a recreated
  # cluster (new identifier) re-runs the DDL against the fresh, empty database.
  input = {
    database   = "tracking"
    cluster_id = module.rds_mysql.cluster_identifier
  }

  provisioner "local-exec" {
    command     = "${abspath("${path.root}/../../../.venv/bin/python")} ${abspath("${path.root}/scripts/create_mysql_database.py")} ${self.input.database}"
    interpreter = ["/usr/bin/env", "bash", "-c"]
    environment = {
      # Traceability only: the script always runs and the log never causes a
      # skip. Set explicitly rather than relying on the Makefile's exported
      # value being inherited, so a `terraform apply` run by hand records too.
      EXECUTION_LOG_TABLE = var.execution_log_table
    }
  }
}

# ─── Cognito ────────────────────────────────────────────────────────────────────
# manage_client_via_provider = false (LOCAL ONLY): the native
# aws_cognito_user_pool_client resource cannot apply cleanly against Floci —
# see modules/cognito/variables.tf's manage_client_via_provider description
# and the floci skill (quirk #2). The client is created instead via an awscli
# local-exec fallback in that module, pointed at the same endpoint as the aws
# provider above. Prod/Ministack keep the default (true).
module "cognito" {
  source                     = "../../modules/cognito"
  context                    = { id = module.label_cognito.id, tags = module.label_cognito.tags }
  region                     = local.region
  issuer_style               = "floci"
  manage_client_via_provider = false
  aws_cli_endpoint_url       = "http://localhost:4566"
  # The venv interpreter for the module's awscli-fallback provisioners. Resolved
  # from THIS root (path.root = environments/local), because the shared module
  # cannot know its distance to the repo root. `make scripts-setup` — a
  # prerequisite of every apply target — guarantees it exists.
  python_bin = abspath("${path.root}/../../../.venv/bin/python")
  # Traceability log for those same two provisioners. The module defaults this
  # to "" (record nothing), which is what prod wants — there the client is
  # managed by the native provider and neither script runs.
  execution_log_table = var.execution_log_table

  # The OTP challenge Lambda publishes AUTH_OTP_REQUESTED to the shared events
  # queue, which the events-pipeline Lambda consumes to mail the code. Declared
  # AFTER module.messaging in this file but resolved by the dependency graph,
  # not by file order.
  events_queue_url = module.messaging.queue_url
  events_queue_arn = module.messaging.queue_arn

  # The Lambda runs as a Docker container on 3mrai-network, so its endpoint is
  # the IN-NETWORK name — NOT the localhost:4566 the host-side provisioners use
  # above. Same distinction the events-pipeline Lambda makes.
  aws_cli_endpoint_url_in_network = "http://floci:4566"
  # LOCAL ONLY: real AWS rejects AWS_REGION as a reserved Lambda env key, so the
  # module omits it when this is "" (its default, i.e. production).
  lambda_region_env = local.region
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

# ─── Messaging (SQS events queue + DLQ) ─────────────────────────────────────────
# The single shared events queue: Users/Orders/Tracking publish to it, the
# events-pipeline Lambda below is its only consumer.
module "messaging" {
  source  = "../../modules/messaging"
  context = { id = module.label_events.id, tags = module.label_events.tags }
}

# ─── DocumentDB (events-pipeline store) ─────────────────────────────────────────
# Same letter-led-id trick as rds_aurora/rds_mysql: module.label_events.id is
# "3mrai-local-events" (digit-leading), and the database module interpolates
# context.id into aws_docdb_cluster.cluster_identifier, which AWS rejects unless
# it starts with a letter — so prefix with "db-". The prefix is NOT decorative;
# dropping it makes the cluster identifier invalid. It is "db-" rather than
# "docdb-" because the module already appends its own "-docdb" suffix, so the
# latter would read docdb-3mrai-local-events-docdb.
#
# Resulting cluster identifier: db-3mrai-local-events-docdb. That value derives
# Floci's backing container name (floci-docdb-<cluster_identifier>), which is
# how anything on 3mrai-network reaches Mongo — port 27017 is NOT published to
# the host and the reported IP changes on every recreation. Changing this
# identifier forces cluster REPLACEMENT and invalidates every consumer of that
# container name, so treat it as a stable contract from here on. See
# docs/lessons/floci-sqs-lambda-docdb-support.md.
#
# manage_cluster_via_provider = false (LOCAL ONLY): the native aws_docdb_cluster
# resource cannot apply against Floci — it fails with
#   creating DocumentDB Cluster (db-3mrai-local-events-docdb):
#   InvalidClientTokenId: The security token included in the request is invalid.
#   status code: 403
# while the IDENTICAL CreateDBCluster call through the AWS CLI / boto3 succeeds
# against the same live Floci (verified 2026-08-03: the cluster comes back
# Status "available" on port 27017, with its floci-docdb-<id> container running).
# So Floci implements DocumentDB fine and the pinned provider (`= 5.31.0`,
# non-negotiable — newer versions break aws_cognito_user_pool_client here) signs
# this request in a way Floci's docdb handler rejects. That is the same class of
# failure create_subnet_group already works around one resource earlier, and it
# meets the awscli-fallback pattern's bar: proven by a real apply failure, with a
# proven-working SDK equivalent. Prod keeps the default (true) and the native
# resources. See docs/shared/patterns/awscli-fallback-for-floci.md.
module "docdb" {
  source                      = "../../modules/docdb"
  context                     = { id = "db-${module.label_events.id}", tags = module.label_events.tags }
  subnet_ids                  = module.networking.subnet_ids
  security_group_ids          = module.networking.security_group_ids
  master_password             = var.docdb_password
  create_subnet_group         = false
  subnet_group_name           = "default"
  manage_cluster_via_provider = false
  aws_cli_endpoint_url        = "http://localhost:4566"
  region                      = local.region
  # Same reasoning as the cognito module's python_bin: resolved from THIS root
  # (path.root = environments/local), because the shared module cannot know its
  # distance to the repo root. `make scripts-setup` — a prerequisite of every
  # apply target — guarantees it exists.
  python_bin = abspath("${path.root}/../../../.venv/bin/python")
  # Traceability log for the fallback provisioner. The module defaults this to
  # "" (record nothing), which is what prod wants — there the script never runs.
  execution_log_table = var.execution_log_table
}

# ─── Events Pipeline Lambda ─────────────────────────────────────────────────────
# source_dir points at the BUILT dist/ output of functions/events-pipeline. That
# directory must exist before plan/apply: archive_file is a data source, read at
# plan time. Build the function first (Block B produces it) — `terraform
# validate` does not evaluate data sources and so passes without it.
#
# ─── SES sender identity ────────────────────────────────────────────────────────
# Real AWS refuses SendEmail from an unverified address ("MessageRejected: Email
# address is not verified"), so the from-address must be verified before the
# pipeline can mail anyone. Floci does NOT enforce this — verified empirically:
# `ses list-identities` returned empty and delivery still succeeded — which is
# exactly why it belongs in Terraform rather than being discovered missing in
# production. Verification is immediate here; real AWS sends a confirmation mail.
resource "aws_ses_email_identity" "events_pipeline_sender" {
  email = var.ses_from_address
}

# The Lambda runs as a Docker container on 3mrai-network (Floci), so its
# endpoint/host values are IN-NETWORK names (floci:4566, the docdb container
# name), never localhost.
module "lambda_events_pipeline" {
  source     = "../../modules/lambda"
  context    = { id = module.label_events.id, tags = module.label_events.tags }
  queue_arn  = module.messaging.queue_arn
  source_dir = "${path.module}/../../../functions/events-pipeline/dist"

  environment_variables = {
    AWS_ENDPOINT_URL = "http://floci:4566"
    # Set explicitly: real Lambda injects AWS_REGION into every execution
    # environment, but whether Floci's Lambda container does is unverified. This
    # function calls SES, and a missing region surfaces there as a confusing
    # credentials/endpoint error rather than an obvious "no region configured".
    AWS_REGION     = local.region
    DOCDB_HOST     = "floci-docdb-${module.docdb.cluster_identifier}"
    DOCDB_PORT     = tostring(module.docdb.port)
    DOCDB_USERNAME = module.docdb.master_username
    DOCDB_PASSWORD = var.docdb_password
    # LOCAL ONLY: Floci backs DocumentDB with a stock mongo:7.0 container, whose
    # MONGO_INITDB_ROOT_* user is created in the `admin` database, not in the
    # target database. Without authSource=admin on the connection URI the
    # driver reports "MongoServerError: Authentication failed" (verified both
    # ways). Real Amazon DocumentDB authenticates the master user against the
    # target database itself, so this is NOT set for production — see
    # DOCDB_AUTH_SOURCE in functions/events-pipeline/src/shared/config/env.ts.
    DOCDB_AUTH_SOURCE = "admin"
    SES_FROM_ADDRESS  = var.ses_from_address
    # Base URL the email templates append icon keys to. The templates render
    # REMOTE <img> tags (100% client support) rather than base64 data: URIs
    # (80.95%), so without this every icon in every email is a broken URL. The
    # function's Zod schema requires it, so a missing value kills the Lambda at
    # boot instead of silently mailing broken images — see
    # functions/events-pipeline/src/shared/config/env.ts.
    #
    # `localhost`, not `floci`, on purpose: this URL is resolved by the reader's
    # mail client on the HOST, never fetched by the Lambda itself. See
    # var.assets_base_url for the full argument and for why this is a variable
    # rather than a read of the phase-2 bucket output.
    ASSETS_BASE_URL = var.assets_base_url
  }
}

# ─── API Gateway ────────────────────────────────────────────────────────────────
# local_gateway = true: Floci drops the request path on HTTP_PROXY integrations,
# so the module creates one integration per route with the path baked into the
# URI. nginx_base_uri uses the stable Docker-DNS alias (proven in the spike) —
# the ECS task is recreated on every apply, so pinning to a discovered IP would
# break. Prod keeps local_gateway = false (single shared integration).
module "api_gateway" {
  source                   = "../../modules/api-gateway"
  context                  = { id = module.label_api.id, tags = module.label_api.tags }
  cognito_issuer           = module.cognito.issuer
  cognito_audience         = module.cognito.client_id
  local_gateway            = true
  nginx_base_uri           = "http://nginx-stable"
  enable_e2e_cleanup_route = true

  # ON: the Tracking service now exists AND nginx has a `tracking` upstream
  # (`location = /v1/tracking/health` + `location /v1/trackings`, both on port
  # 8000 — see modules/compute/nginx/nginx.conf). Until that upstream existed,
  # nginx's default `location /` sent /v1/trackings/* to users:3000 — a green
  # health check served by the wrong service is harder to spot than a 404. The
  # two must stay in lockstep: removing the nginx locations means flipping this
  # back to false in the same change.
  enable_tracking_routes = true
}
