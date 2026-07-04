output "writer_endpoint" {
  description = "Aurora cluster writer endpoint (use for INSERT / UPDATE queries)."
  value       = aws_rds_cluster.this.endpoint
}

output "reader_endpoint" {
  description = "Aurora cluster reader endpoint (use for SELECT queries, per ADR-0006)."
  value       = aws_rds_cluster.this.reader_endpoint
}

output "secret_arn" {
  description = "ARN of the Secrets Manager secret that holds the Aurora master credentials."
  value       = aws_secretsmanager_secret.db_credentials.arn
  sensitive   = true
}

output "cluster_identifier" {
  description = "Aurora cluster identifier."
  value       = aws_rds_cluster.this.cluster_identifier
}

output "port" {
  description = "Port the Aurora cluster listens on."
  value       = aws_rds_cluster.this.port
}

output "app_secret_arn" {
  description = "ARN of the least-privilege app-user credentials secret (null if not managed)."
  value       = var.manage_app_user ? aws_secretsmanager_secret.app_credentials[0].arn : null
}
