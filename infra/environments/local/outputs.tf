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
  value       = module.database.cluster_identifier
}

output "docdb_port" {
  description = "DocumentDB port."
  value       = module.database.port
}

output "events_lambda_function_name" {
  description = "Name of the events-pipeline Lambda function."
  value       = module.lambda_events_pipeline.function_name
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
