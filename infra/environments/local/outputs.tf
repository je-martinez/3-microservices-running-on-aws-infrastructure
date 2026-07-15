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

output "app_secret_arn" {
  description = "ARN of the least-privilege app-user credentials secret."
  value       = module.rds_aurora.app_secret_arn
}
