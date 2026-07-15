output "app_secret_arn" {
  description = "ARN of the least-privilege app-user credentials secret."
  value       = aws_secretsmanager_secret.app.arn
  sensitive   = true
}
