# =============================================================================
# environments/local outputs
#
# These values are consumed by:
#   - bootstrap.sh  (api_id, integration_id to patch the API GW integration)
#   - docker-compose .env  (cognito_user_pool_id, cognito_client_id injected
#                           into the `users` service environment)
#   - Prisma migration  (database_writer_url)
#   - E2E tests  (api_invoke_url as API_INVOKE_URL)
# =============================================================================

# ─── API Gateway ──────────────────────────────────────────────────────────────

# Ministack quirk: the stage invoke_url is a real AWS-format domain.
# The locally reachable URL form is http://<api-id>.execute-api.localhost:4566.
# bootstrap.sh derives the local URL from api_id automatically.
output "api_invoke_url" {
  description = "API Gateway stage invoke URL (Ministack: http://<api-id>.execute-api.localhost:4566)."
  value       = module.api_gateway.invoke_url
}

output "api_id" {
  description = "API Gateway ID. Used by bootstrap.sh to patch the nginx integration URI."
  value       = module.api_gateway.api_id
}

output "integration_id" {
  description = "Nginx HTTP_PROXY integration ID. Used by bootstrap.sh to call update-integration."
  value       = module.api_gateway.integration_id
}

# ─── Database ─────────────────────────────────────────────────────────────────

output "database_writer_url" {
  description = "PostgreSQL connection URL for the Aurora writer endpoint. Used by Prisma migrate deploy."
  value       = "postgresql://${module.rds_aurora.writer_endpoint}/users?user=postgres&password=${var.db_master_password}"
  sensitive   = true
}

output "database_reader_url" {
  description = "PostgreSQL connection URL for the Aurora reader endpoint. Used by the users service READ queries."
  value       = "postgresql://${module.rds_aurora.reader_endpoint}/users?user=postgres&password=${var.db_master_password}"
  sensitive   = true
}

output "db_secret_arn" {
  description = "ARN of the Secrets Manager secret holding Aurora master credentials."
  value       = module.rds_aurora.secret_arn
  sensitive   = true
}

# ─── Cognito ──────────────────────────────────────────────────────────────────

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID. Injected into the users service via COGNITO_USER_POOL_ID."
  value       = module.cognito.user_pool_id
}

output "cognito_client_id" {
  description = "Cognito App Client ID. Injected into the users service via COGNITO_CLIENT_ID."
  value       = module.cognito.client_id
}

output "cognito_issuer" {
  description = "JWT issuer URL (AWS-format). Used by the API Gateway authorizer."
  value       = module.cognito.issuer
}

# ─── Compute ──────────────────────────────────────────────────────────────────

output "ecs_cluster_name" {
  description = "ECS cluster name. Used by bootstrap.sh to identify the Nginx task."
  value       = module.compute.cluster_name
}

output "ecs_service_name" {
  description = "ECS service name running the Nginx reverse proxy."
  value       = module.compute.service_name
}

output "ecs_task_family" {
  description = "Nginx ECS task definition family. bootstrap.sh uses this to find the running container."
  value       = module.compute.task_definition_family
}
