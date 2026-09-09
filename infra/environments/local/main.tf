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
# WHY: `subnets` is omitted so the module uses its own default (2 AZs,
# 10.0.1.0/24 + 10.0.2.0/24). Root `var.subnets` is a list(string) of CIDRs and
# the module wants list(object({suffix, cidr, az})) — not interchangeable.
module "networking" {
  source   = "../../modules/networking"
  context  = { id = module.label_net.id, tags = module.label_net.tags }
  vpc_cidr = var.vpc_cidr
}

# ─── Aurora Postgres ────────────────────────────────────────────────────────────
# CONTRACT: Keep the letter-led "aurora-" prefix on context.id. module.label_db.id
# is digit-leading ("3mrai-local-aurora") and rds-aurora interpolates it into
# cluster_identifier, which the provider rejects unless it starts with a letter.
# See [[ADR-0001-terraform-cloudposse-naming]]
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
  # WORKAROUND(local): Do NOT set manage_app_user = true here. The postgresql
  # provider is configured before the cluster exists, so no host/port default can
  # be correct on a clean apply. Phase 2 creates the app user instead. Prod keeps
  # the default (true) against a stable Aurora endpoint.
  # See [[two-phase-terraform-apply]]
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
# CONTRACT: Keep the letter-led "mysql-" prefix on context.id — rds-aurora feeds
# it to cluster_identifier, which the provider rejects on a digit-leading name.
# WORKAROUND(local): Do NOT set manage_app_user = true. The mysql provider needs
# the cluster endpoint before the cluster exists; phase 2 creates orders_app.
# See [[two-phase-terraform-apply]]
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
# CONTRACT: Do NOT add a second cluster with engine = "mysql". Floci assigns RDS
# proxy ports (7000-7099) by cluster creation order, so consumers resolve a port
# by matching the `Engine` field; two mysql clusters make that lookup return
# whichever came first, non-deterministically. Tracking is a second DATABASE on
# the existing rds_mysql cluster.
# WORKAROUND(local): Adding a database to a live cluster is engine DDL — no AWS
# API and no mysql-provider resource can do it here (the provider needs the
# endpoint before the cluster exists), so this uses the awscli-fallback shape.
# See [[awscli-fallback-for-floci]]
resource "terraform_data" "tracking_database" {
  # CONTRACT: Keep cluster_id in `input`. It is what makes a recreated cluster
  # replace this resource and re-run the DDL against the fresh, empty database.
  input = {
    database   = "tracking"
    cluster_id = module.rds_mysql.cluster_identifier
  }

  provisioner "local-exec" {
    command     = "${abspath("${path.root}/../../../.venv/bin/python")} ${abspath("${path.root}/scripts/create_mysql_database.py")} ${self.input.database}"
    interpreter = ["/usr/bin/env", "bash", "-c"]
    environment = {
      # WHY: Traceability only — the log never skips a run. Set explicitly so a
      # hand-run `terraform apply` records too, without the Makefile's export.
      EXECUTION_LOG_TABLE = var.execution_log_table
    }
  }
}

# ─── Cognito ────────────────────────────────────────────────────────────────────
# WORKAROUND(local): Do NOT set manage_client_via_provider = true here. The
# native aws_cognito_user_pool_client cannot apply against Floci; the module
# creates the client through an awscli local-exec fallback instead. Prod keeps
# the default (true).
# See [[awscli-fallback-for-floci]]
module "cognito" {
  source                     = "../../modules/cognito"
  context                    = { id = module.label_cognito.id, tags = module.label_cognito.tags }
  region                     = local.region
  issuer_style               = "floci"
  manage_client_via_provider = false
  aws_cli_endpoint_url       = "http://localhost:4566"
  # CONTRACT: Pass the venv interpreter by absolute path, never plain `python3` —
  # the ambient one may resolve into an unrelated venv. Resolved from THIS root
  # because the shared module cannot know its distance to the repo root.
  # See [[scripting-language]]
  python_bin = abspath("${path.root}/../../../.venv/bin/python")
  # WHY: Traceability log for those two provisioners. The module defaults to ""
  # (record nothing), which is what prod wants — neither script runs there.
  execution_log_table = var.execution_log_table

  # WHY: The OTP challenge Lambda publishes AUTH_OTP_REQUESTED to the shared
  # queue for the events-pipeline Lambda to mail. module.messaging is declared
  # below; the dependency graph resolves it, not file order.
  events_queue_url = module.messaging.queue_url
  events_queue_arn = module.messaging.queue_arn

  # CONTRACT: In-network name, NOT the localhost:4566 the host-side provisioners
  # use above — the Lambda runs as a container on 3mrai-network and cannot reach
  # the host's localhost.
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
# CONTRACT: Keep the "db-" prefix on context.id. Floci derives its container name
# floci-docdb-<cluster_identifier> from it, and that name is the only route to
# Mongo on 3mrai-network (27017 is not published, the reported IP changes on every
# recreation); renaming forces cluster REPLACEMENT.
# See [[floci-sqs-lambda-docdb-support]]
# WORKAROUND(local): manage_cluster_via_provider=false. The native aws_docdb_cluster
# gets a 403 from Floci while the identical boto3 CreateDBCluster succeeds.
# Prod keeps the default (true) and the native resources.
# See [[awscli-fallback-for-floci]]
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
  # CONTRACT: Absolute venv interpreter, never plain `python3` — see the cognito
  # module's python_bin above. See [[scripting-language]]
  python_bin = abspath("${path.root}/../../../.venv/bin/python")
  # Traceability log for the fallback provisioner. The module defaults this to
  # "" (record nothing), which is what prod wants — there the script never runs.
  execution_log_table = var.execution_log_table
}

# ─── Redis / ElastiCache (Users password-reset codes) ───────────────────────────
# CONTRACT: Keep the "cache-" prefix on context.id. Floci derives the container
# name floci-valkey-<id> from it, and that name is the only route to Redis (the
# API reports ConfigurationEndpoint "localhost"); renaming breaks REDIS_HOST.
# WORKAROUND(local): manage_via_provider=false. The native
# aws_elasticache_replication_group panics provider 5.31.0 against Floci and
# wedges state (group created, nothing in state, retry hits
# ReplicationGroupAlreadyExistsFault). Prod keeps the default.
# WORKAROUND(local): create_subnet_group=false and no subnet_group_name — Floci
# answers UnsupportedOperation for ElastiCache subnet groups and there is no
# "default" to fall back to; the container joins the compose network directly.
# See [[floci-elasticache-two-ports-and-provider-panic]]
module "redis" {
  source              = "../../modules/redis"
  context             = { id = "cache-${module.label_cache.id}", tags = module.label_cache.tags }
  description         = "Short-lived codes (password reset) for the Users service"
  manage_via_provider = false
  create_subnet_group = false
  # WORKAROUND(local): Floci terminates no TLS, so the client dials plain
  # redis://. Production opts in per environment. See [[ADR-0017-floci-local]]
  transit_encryption_enabled = false
  aws_cli_endpoint_url       = "http://localhost:4566"
  region                     = local.region
  # CONTRACT: Absolute venv interpreter, never plain `python3` — see the cognito
  # module's python_bin above. See [[scripting-language]]
  python_bin = abspath("${path.root}/../../../.venv/bin/python")
  # WHY: Traceability log for the fallback provisioner. The module defaults to ""
  # (record nothing), which is what prod wants — the script never runs there.
  execution_log_table = var.execution_log_table
}

# ─── Realtime WebSocket (connections registry + WS API) ─────────────────────────
# The connection registry: one row per open socket, written by the $connect /
# $disconnect handlers and read by the events-pipeline's fan-out.
module "ws_connections" {
  source  = "../../modules/dynamodb"
  context = { id = module.label_realtime.id, tags = module.label_realtime.tags }
}

# CONTRACT: Build functions/realtime-events before plan/apply. source_dir points
# at its dist/, and archive_file is a data source read at PLAN time; `terraform
# validate` does not evaluate data sources, so it passes without the build.
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
  # CONTRACT: Pass the issuer as configuration; do NOT derive it inside the
  # Lambda from the pool id. Floci stamps http://localhost:4566/<pool-id> as
  # `iss`, which a derived issuer will not match, and every token is rejected.
  cognito_issuer = module.cognito.issuer

  # CONTRACT: In-network name. These four Lambdas run as containers on
  # 3mrai-network and cannot reach the host's localhost.
  aws_endpoint_url = "http://floci:4566"

  # ─── Traces ─────────────────────────────────────────────────────────────
  # CONTRACT: OTLP config lives here, never in the Lambdas' code — an SDK option
  # passed in code reads as "not overridden" and auto-detection silently wins.
  # tracing.ts constructs OTLPTraceExporter with no arguments for that reason.
  # Applied to all four functions at once (one for_each'd resource).
  # See [[logging-context]]
  environment_variables = {
    # CONTRACT: Base url only — the exporter appends /v1/traces per the OTLP
    # spec; a hand-built full path POSTs every batch to the collector's root and
    # collects silent 404s. Host is the in-network sibling container name.
    OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector:4318"
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
    OTEL_SERVICE_NAME           = "realtime-events"
    # CONTRACT: Disable these here, not in code. NodeSDK auto-detects both
    # exporters from OTEL_EXPORTER_OTLP_ENDPOINT and an `undefined` SDK option
    # loses to auto-detection; the collector serves /v1/traces only.
    # See [[logging-context]]
    OTEL_METRICS_EXPORTER = "none"
    OTEL_LOGS_EXPORTER    = "none"
  }
}

# ─── Events Pipeline Lambda ─────────────────────────────────────────────────────
# CONTRACT: Build functions/events-pipeline before plan/apply — source_dir points
# at its dist/ and archive_file is a data source read at PLAN time; `terraform
# validate` does not evaluate data sources, so it passes without the build.

# ─── SES sender identity ────────────────────────────────────────────────────────
# CONTRACT: Keep the sender identity in Terraform even though Floci ignores it.
# Real AWS refuses SendEmail from an unverified address ("MessageRejected"), so
# without this the pipeline mails nobody in production.
resource "aws_ses_email_identity" "events_pipeline_sender" {
  email = var.ses_from_address
}

# CONTRACT: This Lambda's endpoint/host values are IN-NETWORK names (floci:4566,
# the docdb container name) — it runs as a container on 3mrai-network and cannot
# reach the host's localhost.
module "lambda_events_pipeline" {
  source     = "../../modules/lambda"
  context    = { id = module.label_events.id, tags = module.label_events.tags }
  queue_arn  = module.messaging.queue_arn
  dlq_arn    = module.messaging.dlq_arn
  source_dir = "${path.module}/../../../functions/events-pipeline/dist"

  # WHY: Realtime fan-out grants — Query on the by-cognito-sub GSI, DeleteItem for
  # the 410-Gone pruning path, ManageConnections to push a frame. Both default to
  # "" so a consumer that does not fan out gets no extra policy.
  ws_connections_table_arn  = module.ws_connections.table_arn
  ws_manage_connections_arn = module.api_gateway_ws.manage_connections_arn

  # WHY: A throughput knob, not a tracing one — handler.ts parents every record to
  # its own origin regardless of batch size (recordSpanAttachment), so traces stay
  # continuous at any size. 10 is the module default; the whole batch shares one
  # 30s timeout and one DocumentDB connection, which is what bounds it.
  batch_size = 10

  # WORKAROUND(local): Four pollers because Floci keeps one invocation in flight
  # per mapping, so mapping count is the only concurrency knob. Do NOT raise this
  # in a deployed environment — real Lambda scales one mapping out by itself, and
  # each extra poller is another container on the host running the whole stack.
  mapping_count = 4

  # WORKAROUND(local): The E2E email-query route. Floci does not publish 27017 to
  # the host, so a Playwright process can only read e2e_emails through the
  # function that already holds the connection. The module defaults this to
  # false, so production gets no public URL by omission.
  enable_function_url = true

  environment_variables = {
    AWS_ENDPOINT_URL = "http://floci:4566"
    # WHY: Set explicitly because Floci's Lambda container may not inject it. A
    # missing region surfaces from the SES call as a credentials/endpoint error
    # rather than an obvious "no region configured".
    AWS_REGION     = local.region
    DOCDB_HOST     = "floci-docdb-${module.docdb.cluster_identifier}"
    DOCDB_PORT     = tostring(module.docdb.port)
    DOCDB_USERNAME = module.docdb.master_username
    DOCDB_PASSWORD = var.docdb_password
    # WORKAROUND(local): Do NOT set this in production. Floci's stock mongo:7.0
    # creates its root user in `admin`, so without authSource=admin the driver
    # reports "MongoServerError: Authentication failed"; real DocumentDB
    # authenticates the master user against the target database instead.
    # See [[floci-sqs-lambda-docdb-support]]
    DOCDB_AUTH_SOURCE = "admin"
    # WHY: Email sent/failed counters to CloudWatch, under the IAM role's
    # 3MRAI-scoped PutMetricData grant. This is the DEPLOYED function's value;
    # .env.local.events-pipeline only serves local tests.
    METRICS_ENABLED  = "true"
    SES_FROM_ADDRESS = var.ses_from_address
    # WHY: Where the handler writes a message it rejects as UNPROCESSABLE. Such a
    # message is deleted on return and never reaches the redrive path, so without
    # this it is gone with no copy anywhere — see #pipeline/quarantine.
    EVENTS_DLQ_URL = module.messaging.dlq_url
    # CONTRACT: A host-resolvable URL (localhost, NOT floci) — the reader's mail
    # client fetches these icons, the Lambda never does. Templates render remote
    # <img> tags, so a wrong host is a broken icon in every email.
    ASSETS_BASE_URL = var.assets_base_url

    # ─── Realtime WebSocket fan-out ─────────────────────────────────────────
    WS_CONNECTIONS_TABLE = module.ws_connections.table_name
    WS_CONNECTIONS_GSI   = module.ws_connections.gsi_name
    # WORKAROUND(local): Floci's @connections endpoint carries an undocumented
    # /execute-api/{apiId}/{stage} prefix, unlike real AWS. A wrong shape answers
    # HTTP 400 with an S3 XML body (unrouted :4566 paths fall through to S3),
    # which looks nothing like an endpoint error.
    WS_MANAGEMENT_ENDPOINT = module.api_gateway_ws.management_endpoint_local

    # ─── Traces ─────────────────────────────────────────────────────────────
    # CONTRACT: OTLP config lives here, never in the Lambda's code — an SDK
    # option passed in code loses to auto-detection. Base url only: the exporter
    # appends /v1/traces per the OTLP spec, and a hand-built full path POSTs to
    # the collector's root for silent 404s. Host is the in-network sibling.
    # See [[logging-context]]
    OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector:4318"
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
    OTEL_SERVICE_NAME           = "events-pipeline"
    # CONTRACT: Disable these here, not in code. NodeSDK auto-detects both
    # exporters from OTEL_EXPORTER_OTLP_ENDPOINT and an `undefined` SDK option
    # loses to auto-detection; the collector serves /v1/traces only.
    # See [[logging-context]]
    OTEL_METRICS_EXPORTER = "none"
    OTEL_LOGS_EXPORTER    = "none"

    # ─── E2E email store ────────────────────────────────────────────────────
    # CONTRACT: Do NOT set these three in a deployed environment — e2e_emails is
    # then never written and the Function URL answers 404. E2E_TESTING_ENABLED
    # gates both the write and the read route, under the same flag name the
    # three services use for their own E2E-only routes.
    E2E_TESTING_ENABLED = "true"
    # WHY: An hour outlasts any suite run and still keeps a developer's machine
    # clean. Expiry is a Mongo TTL index, not a sweeper.
    E2E_EMAIL_TTL_SECONDS = "3600"
    # WARNING: This token, not the URL, is the boundary — the Function URL is
    # AuthType NONE. The handler compares it in constant time and answers 404,
    # not 401, so an unauthenticated caller cannot tell the route exists.
    E2E_QUERY_TOKEN = var.e2e_query_token
  }
}

# ─── events-pipeline metrics tick ───────────────────────────────────────────────
# CONTRACT: Do NOT remove this rule or seed the counters from the SQS path
# instead. emails_sent_total/emails_failed_total only emit when mail moves, so a
# quiet window leaves the series empty and OpenObserve's metric panel throws
# `Cannot read properties of undefined (reading 'values')` rather than showing 0.
# A Lambda hosts no periodic loop of its own, so the clock comes from EventBridge
# at rate(1 minute) — its floor, and the same cadence the services' gauges use.
# See [[logging-context]]
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

  # CONTRACT: This string must match METRICS_TICK_DETAIL_TYPE in src/handler.ts —
  # the handler branches on it to tell a tick from an SQS batch. Matching on
  # shape ("no Records field") instead swallows a malformed SQS delivery and
  # reports success on dropped mail.
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

  # CONTRACT: Keep this in lockstep with nginx's `tracking` locations
  # (modules/compute/nginx/nginx.conf). Without them, the default `location /`
  # sends /v1/trackings/* to users:3000 — a green health check served by the
  # wrong service, which is harder to spot than a 404.
  enable_tracking_routes = true
}
