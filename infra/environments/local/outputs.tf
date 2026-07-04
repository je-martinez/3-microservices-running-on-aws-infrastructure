output "api_invoke_url" {
  description = "API Gateway invoke URL (hit /v1/health through this)."
  value       = module.api_gateway.invoke_url
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

output "app_secret_arn" {
  description = "ARN of the least-privilege app-user credentials secret."
  value       = module.rds_aurora.app_secret_arn
}
