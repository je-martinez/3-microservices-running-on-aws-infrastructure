output "api_invoke_url" {
  description = "API Gateway invoke URL (hit /v1/health through this)."
  value       = module.api_gateway.invoke_url
}

output "api_id" {
  description = "HTTP API Gateway id. Used by `make env-file` to build the reachable local invoke URL."
  value       = module.api_gateway.api_id
}

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID."
  value       = module.cognito.user_pool_id
}

output "cognito_client_id" {
  description = "Cognito App Client ID."
  value       = module.cognito.client_id
}

output "db_writer_endpoint" {
  description = "Aurora cluster writer endpoint (INSERT/UPDATE queries)."
  value       = module.rds_aurora.writer_endpoint
}

output "db_reader_endpoint" {
  description = "Aurora cluster reader endpoint (SELECT queries, per ADR-0006)."
  value       = module.rds_aurora.reader_endpoint
}

output "orders_db_writer_endpoint" {
  description = "Orders MySQL cluster writer endpoint (INSERT/UPDATE queries)."
  value       = module.rds_mysql.writer_endpoint
}

output "orders_db_reader_endpoint" {
  description = "Orders MySQL cluster reader endpoint (SELECT queries, per ADR-0006)."
  value       = module.rds_mysql.reader_endpoint
}

# Tracking shares the Orders MySQL CLUSTER (see terraform_data.tracking_database
# in main.tf for why there is no second cluster) — only the database/schema
# differs. These outputs therefore resolve to the same endpoints as the
# orders_db_* ones above; they exist as separate names so the env-file generator
# and any future consumer address Tracking's connection by its own key rather
# than reaching for an Orders output and quietly coupling the two.
output "tracking_db_writer_endpoint" {
  description = "Tracking MySQL writer endpoint (INSERT/UPDATE queries). Same cluster as Orders, different database."
  value       = module.rds_mysql.writer_endpoint
}

output "tracking_db_reader_endpoint" {
  description = "Tracking MySQL reader endpoint (SELECT queries, per ADR-0006). Same cluster as Orders, different database."
  value       = module.rds_mysql.reader_endpoint
}

# ─── Events pipeline (SQS + DocumentDB + Lambda) ────────────────────────────────
output "events_queue_url" {
  description = "URL of the shared events SQS queue (consumed by the Users/Orders/Tracking publishers)."
  value       = module.messaging.queue_url
}

output "events_dlq_url" {
  description = "URL of the events dead-letter queue (messages land here after max_receive_count deliveries)."
  value       = module.messaging.dlq_url
}

output "docdb_cluster_identifier" {
  description = "DocumentDB cluster identifier, used to derive the floci-docdb-<id> container name — the only way to reach Mongo locally (27017 is not published to the host)."
  value       = module.docdb.cluster_identifier
}

output "docdb_port" {
  description = "DocumentDB port."
  value       = module.docdb.port
}

output "docdb_master_username" {
  description = "DocumentDB master username, read by `make env-file` for DOCDB_USERNAME (the module's own default; main.tf never overrides master_username)."
  value       = module.docdb.master_username
}

output "events_lambda_function_name" {
  description = "Name of the events-pipeline Lambda function."
  value       = module.lambda_events_pipeline.function_name
}

# ─── Redis / ElastiCache (Users password-reset codes) ───────────────────────────
# Consumed by `make env-file` to write REDIS_HOST / REDIS_PORT into
# .env.local.users.
#
# redis_host is the BACKING CONTAINER NAME locally (floci-valkey-<id>), NOT the
# endpoint ElastiCache reports — Floci returns ConfigurationEndpoint.Address =
# "localhost", which from inside the Docker network resolves to the calling
# service's own container. Same shape as docdb_cluster_identifier above, except
# the module does the derivation so consumers read one ready-to-use value.
output "redis_host" {
  description = "Host the Users service connects to for Redis. LOCAL: the floci-valkey-<id> container name over Docker DNS — never 'localhost'. PROD: the ElastiCache primary endpoint."
  value       = module.redis.redis_host
}

output "redis_port" {
  description = "Redis port (6379 both locally and in AWS)."
  value       = module.redis.redis_port
}

output "redis_replication_group_id" {
  description = "ElastiCache replication group id — derives the floci-valkey-<id> container name. Changing it renames that container and invalidates every REDIS_HOST consumer."
  value       = module.redis.replication_group_id
}

# ─── Realtime WebSocket ─────────────────────────────────────────────────────────
# ws://localhost:4566/ws/{apiId}/{stage} — the HOST-facing data plane, NOT the
# restapis/<id>/$default/_user_request_/ shape the HTTP API uses. Consumed by the
# E2E harness via .env.local.debug.
output "ws_url" {
  description = "WebSocket URL for E2E clients."
  value       = module.api_gateway_ws.ws_url_local
}

output "ws_api_id" {
  description = "WebSocket API id."
  value       = module.api_gateway_ws.api_id
}

output "ws_connections_table" {
  description = "DynamoDB table holding one row per open WebSocket connection."
  value       = module.ws_connections.table_name
}

output "ws_connections_gsi" {
  description = "GSI on cognito_sub the events-pipeline queries to fan out to a user's sockets."
  value       = module.ws_connections.gsi_name
}

# IN-NETWORK (floci:4566): read into the events-pipeline's environment. Not
# host-reachable, and deliberately so — the only consumer is a Lambda container.
output "ws_management_endpoint" {
  description = "@connections management endpoint used by the events-pipeline fan-out (Floci's undocumented /execute-api/ shape)."
  value       = module.api_gateway_ws.management_endpoint_local
}

output "app_secret_arn" {
  description = "ARN of the least-privilege app-user credentials secret."
  value       = module.rds_aurora.app_secret_arn
}

# Master (owner) credentials secret ARN — consumed by the phase-2 post-effects
# root (environments/local/post/) which reads it BY ARN via
# aws_secretsmanager_secret_version to configure the postgresql/mysql providers.
# Secret-only: the ARN travels through remote state, the password never does.
output "secret_arn" {
  description = "ARN of the Secrets Manager secret holding the Aurora master credentials."
  value       = module.rds_aurora.secret_arn
  sensitive   = true
}
