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
module "label_realtime" {
  source      = "../../modules/label"
  namespace   = "3mrai"
  environment = var.environment
  name        = "realtime"
}
module "label_cache" {
  source      = "../../modules/label"
  namespace   = "3mrai"
  environment = var.environment
  name        = "cache"
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

# ─── Redis / ElastiCache (Users password-reset codes) ───────────────────────────
# A short-lived store for password-reset codes (10-minute TTL). Deliberately NOT
# a Postgres table: the data is regenerable, single-key, and expires on its own —
# Redis's native TTL does the cleanup that a table would need a sweeper job for.
#
# Same letter-led-id reasoning as rds_aurora/rds_mysql/docdb: module.label_cache.id
# is "3mrai-local-cache" (digit-leading), and the module interpolates context.id
# into the replication group id, which AWS rejects unless it starts with a
# letter — so prefix with "cache-". Resulting replication group id:
# cache-3mrai-local-cache-redis.
#
# THAT ID IS A CONTRACT, not decoration. Floci names the backing container
# `floci-valkey-<replication_group_id>` (image valkey/valkey:8, attached to
# 3mrai-network with NO host port published), and that container name is the ONLY
# way a service reaches Redis — the API reports ConfigurationEndpoint.Address =
# "localhost", which from inside the network is the caller's own container.
# Changing this identifier renames the container and invalidates every consumer
# of REDIS_HOST. Exactly the DocumentDB quirk above, one data store over.
#
# manage_via_provider = false (LOCAL ONLY): the native
# aws_elasticache_replication_group resource CRASHES the provider against Floci —
#   panic: runtime error: index out of range [0] with length 0
#   .../internal/service/elasticache/replication_group.go:632
#   Error: The terraform-provider-aws_v5.31.0_x5 plugin crashed!
# The provider reads NodeGroups[0] after create to populate the primary endpoint;
# Floci's response carries no NodeGroups array at all. Worse than a plain error:
# the group IS created before the panic but nothing lands in state, so the retry
# fails with ReplicationGroupAlreadyExistsFault and the root is wedged. The
# identical boto3 call succeeds and returns Status "available" (verified
# 2026-08-09). Prod keeps the default (true) and the native resource. See
# docs/shared/patterns/awscli-fallback-for-floci.md.
#
# create_subnet_group = false, and NO subnet_group_name: unlike rds-aurora/docdb
# there is no "default" group to fall back to, because Floci implements no
# subnet-group API at all — CreateCacheSubnetGroup and DescribeCacheSubnetGroups
# both answer UnsupportedOperation. The group is created without one; Floci
# attaches the container to the compose network directly.
module "redis" {
  source              = "../../modules/redis"
  context             = { id = "cache-${module.label_cache.id}", tags = module.label_cache.tags }
  description         = "Short-lived codes (password reset) for the Users service"
  manage_via_provider = false
  create_subnet_group = false
  # Floci terminates no TLS (same as its RDS proxy), so the local client dials
  # plain redis://. Production opts in per environment — see the variable.
  transit_encryption_enabled = false
  aws_cli_endpoint_url       = "http://localhost:4566"
  region                     = local.region
  # Same reasoning as the cognito/docdb modules' python_bin: resolved from THIS
  # root (path.root = environments/local), because the shared module cannot know
  # its distance to the repo root. `make scripts-setup` — a prerequisite of every
  # apply target — guarantees it exists.
  python_bin = abspath("${path.root}/../../../.venv/bin/python")
  # Traceability log for the fallback provisioner. The module defaults this to
  # "" (record nothing), which is what prod wants — there the script never runs.
  execution_log_table = var.execution_log_table
}

# ─── Realtime WebSocket (connections registry + WS API) ─────────────────────────
# The connection registry: one row per open socket, written by the $connect /
# $disconnect handlers and read by the events-pipeline's fan-out.
module "ws_connections" {
  source  = "../../modules/dynamodb"
  context = { id = module.label_realtime.id, tags = module.label_realtime.tags }
}

# The WebSocket API and its four Lambdas (authorizer, $connect, $disconnect,
# $default). source_dir points at the BUILT dist/ of functions/realtime-events —
# archive_file is a data source read at PLAN time, so that directory must exist
# before plan/apply (`pnpm run build` there first). `terraform validate` does not
# evaluate data sources and so passes without it, same as the events-pipeline
# Lambda below.
module "api_gateway_ws" {
  source     = "../../modules/api-gateway-ws"
  context    = { id = module.label_realtime.id, tags = module.label_realtime.tags }
  source_dir = "${path.root}/../../../functions/realtime-events/dist"

  connections_table_name = module.ws_connections.table_name
  connections_table_arn  = module.ws_connections.table_arn

  # `client_id`, NOT `user_pool_client_id` — that is the name modules/cognito
  # actually exports (see its outputs.tf).
  cognito_user_pool_id = module.cognito.user_pool_id
  cognito_client_id    = module.cognito.client_id
  # SAME value the REST API Gateway's native JWT authorizer already consumes
  # below (module.api_gateway.cognito_issuer) — module.cognito.issuer is
  # "floci"-styled here (issuer_style = "floci" above), i.e.
  # http://localhost:4566/<pool-id>, which is what Floci actually stamps as
  # `iss` on every token it mints. See modules/cognito/outputs.tf and
  # api-gateway-ws/variables.tf's cognito_issuer description for why this
  # must be passed as configuration rather than derived inside the Lambda.
  cognito_issuer = module.cognito.issuer

  # IN-NETWORK name: these four Lambdas run as Docker containers on
  # 3mrai-network, so the SDK inside them reaches the emulator as `floci`, never
  # `localhost`. Same distinction the events-pipeline Lambda and the cognito
  # module's OTP Lambda already make.
  aws_endpoint_url = "http://floci:4566"

  # ─── Traces ─────────────────────────────────────────────────────────────
  # OTLP config lives HERE, in environment variables, never in the Lambdas'
  # code — the rule that exists because three silent failures in this repo came
  # from configuring the SDK in code ([[logging-context]]). The bootstrap in
  # functions/realtime-events/src/shared/observability/tracing.ts constructs
  # OTLPTraceExporter with NO arguments precisely so these vars are the only
  # source of truth.
  #
  # Applied to all four functions at once (see the module's
  # environment_variables description): the authorizer, $connect, $disconnect
  # and $default are one for_each'd resource and all four export to the same
  # collector under the same service name.
  environment_variables = {
    # `otel-collector`, NOT `localhost`: like AWS_ENDPOINT_URL above, this is
    # resolved from INSIDE the Lambda containers on 3mrai-network, where the
    # collector is a sibling container of that name (docker-compose.yml). It is
    # a BASE url — the exporter appends /v1/traces itself, per the OTLP spec.
    # Hand-building the full path is what made Orders POST every batch to the
    # collector's root and collect silent 404s.
    OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector:4318"
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
    OTEL_SERVICE_NAME           = "realtime-events"
    # Metrics do NOT travel over OTLP (CloudWatch PutMetricData, scraped from
    # there by the collector) and these Lambdas' logs travel stdout ->
    # CloudWatch, not OTLP. Both must be disabled HERE rather than in code:
    # NodeSDK auto-detects both exporters from OTEL_EXPORTER_OTLP_ENDPOINT, and
    # an `undefined` SDK option reads as "not overridden", so auto-detection
    # still wins. The collector serves /v1/traces only.
    OTEL_METRICS_EXPORTER = "none"
    OTEL_LOGS_EXPORTER    = "none"
  }
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

  # Realtime fan-out grants: Query on the by-cognito-sub GSI + DeleteItem for the
  # 410-Gone pruning path, and ManageConnections to push a frame. Both default to
  # "" in the module, so a consumer that does not fan out gets the same policy it
  # always had.
  ws_connections_table_arn  = module.ws_connections.table_arn
  ws_manage_connections_arn = module.api_gateway_ws.manage_connections_arn

  # One record per invocation, so each invocation belongs to exactly ONE trace.
  #
  # This is a TRACING decision, not a throughput one. A record carries the
  # traceparent of the request that produced it, and a span has exactly one
  # parent — so a batch of N records from N different requests cannot be
  # parented to all of them. handler.ts resolves that by parenting when the
  # batch holds one record and falling back to FOLLOWS_FROM links when it holds
  # several (the shape OpenTelemetry's messaging conventions prescribe for
  # batches). Links are correct, but they do not draw a continuous waterfall:
  # the pipeline's work lands in a separate trace, and reading one order's
  # journey end to end means following a link across traces.
  #
  # At the module default of 10 that was the COMMON case, not the exception —
  # measured over 21 invocations: 19 carried more than one record (up to the
  # full 10), so 90% of orders had their email work detached from the request
  # that caused it. Pinning the batch to 1 makes the parenting branch the only
  # branch, which is why the link branch survives in the handler but never
  # fires here.
  #
  # The cost is more invocations. Accepted deliberately: this pipeline sends
  # emails and fans out WebSocket frames on order events — it is not a
  # high-volume stream, and per-invocation overhead is a fair price for traces
  # that never attribute one customer's email to another customer's order.
  # Raising this again re-enables the link branch and re-detaches the pipeline.
  batch_size = 1

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
    # Email sent/failed counters to CloudWatch. The function's IAM role grants
    # cloudwatch:PutMetricData scoped to the 3MRAI namespace (see
    # modules/lambda/main.tf). This is the DEPLOYED function's value — the
    # .env.local.events-pipeline entry only serves local tests.
    METRICS_ENABLED  = "true"
    SES_FROM_ADDRESS = var.ses_from_address
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

    # ─── Realtime WebSocket fan-out ─────────────────────────────────────────
    WS_CONNECTIONS_TABLE = module.ws_connections.table_name
    WS_CONNECTIONS_GSI   = module.ws_connections.gsi_name
    # LOCAL: Floci's @connections endpoint carries an UNDOCUMENTED
    # /execute-api/{apiId}/{stage} prefix and differs from real AWS's
    # https://{apiId}.execute-api.{region}.amazonaws.com/{stage}. A wrong shape
    # answers HTTP 400 with an S3 XML body — unrouted :4566 paths fall through
    # to Floci's S3 handler — which looks nothing like an endpoint error.
    WS_MANAGEMENT_ENDPOINT = module.api_gateway_ws.management_endpoint_local

    # ─── Traces ─────────────────────────────────────────────────────────────
    # OTLP config lives HERE, in environment variables, never in the Lambda's
    # code — the rule that exists because three silent failures in this repo
    # came from configuring the SDK in code ([[logging-context]]). The bootstrap
    # in functions/events-pipeline/src/shared/observability/tracing.ts
    # constructs OTLPTraceExporter with NO arguments precisely so these vars are
    # the only source of truth.
    #
    # `otel-collector`, NOT `localhost`: like AWS_ENDPOINT_URL and DOCDB_HOST
    # above, this is resolved from INSIDE the Lambda container on
    # 3mrai-network, where the collector is a sibling container of that name
    # (docker-compose.yml). Same value the four realtime-events Lambdas already
    # use. It is a BASE url — the exporter appends /v1/traces itself, per the
    # OTLP spec. Hand-building the full path is what made Orders POST every
    # batch to the collector's root and collect silent 404s.
    OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector:4318"
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
    OTEL_SERVICE_NAME           = "events-pipeline"
    # Metrics do NOT travel over OTLP here (this function publishes its email
    # counters with CloudWatch PutMetricData, scraped from there by the
    # collector) and its logs travel stdout -> CloudWatch, not OTLP. Both must
    # be disabled HERE rather than in code: NodeSDK auto-detects both exporters
    # from OTEL_EXPORTER_OTLP_ENDPOINT, and an `undefined` SDK option reads as
    # "not overridden", so auto-detection still wins. The collector serves
    # /v1/traces only.
    OTEL_METRICS_EXPORTER = "none"
    OTEL_LOGS_EXPORTER    = "none"
  }
}

# ─── events-pipeline metrics tick ───────────────────────────────────────────────
# A clock for the email counters. The Lambda publishes emails_sent_total /
# emails_failed_total, which only emit when mail actually moves — so in a quiet
# window their series has no datapoints and OpenObserve's metric panel throws
# `Cannot read properties of undefined (reading 'values')` instead of showing 0.
#
# Seeding those counters from inside the SQS path could not fix it: that path
# runs only when mail is ALREADY flowing, which is exactly when the zeros are
# not needed. Measured before this rule existed: emails_sent_total had zero
# points over 6h while users_total — published by a real periodic loop — had
# continuous coverage. Every other service hosts its own poller in a
# long-running process; a Lambda has none, so the clock comes from EventBridge.
#
# Verified against Floci before being written (2026-08-14): a rate(1 minute)
# rule DOES invoke the function, twice, 60s apart. Note Floci's Lambda runtime
# emits no START lines, so counting them reads 0 — check the invocations
# themselves, not that filter.
#
# rate(1 minute) is EventBridge's floor, coarser than the services' 15s
# interval. That is sufficient here: the narrowest dashboard range is 5 minutes,
# which gets five points.
resource "aws_cloudwatch_event_rule" "events_pipeline_metrics_tick" {
  name                = "${module.label_events.id}-metrics-tick"
  description         = "Periodic tick so the events-pipeline seeds its email counters even with no mail traffic."
  schedule_expression = "rate(1 minute)"
  tags                = module.label_events.tags
}

resource "aws_cloudwatch_event_target" "events_pipeline_metrics_tick" {
  rule      = aws_cloudwatch_event_rule.events_pipeline_metrics_tick.name
  target_id = "events-pipeline-metrics-tick"
  arn       = module.lambda_events_pipeline.function_arn

  # The handler branches on `detail-type` to tell a tick from an SQS batch, so
  # the constant here is a CONTRACT with src/handler.ts (METRICS_TICK_DETAIL_TYPE),
  # not decoration. Matching on the shape instead — "no Records field" — would
  # also swallow a malformed SQS delivery and report success on dropped mail.
  input = jsonencode({
    "detail-type" = "3mrai.metrics.tick"
  })
}

resource "aws_lambda_permission" "events_pipeline_metrics_tick" {
  statement_id  = "AllowExecutionFromEventBridgeMetricsTick"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda_events_pipeline.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.events_pipeline_metrics_tick.arn
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
