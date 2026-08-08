output "table_name" {
  description = "Name of the WebSocket connections table."
  value       = aws_dynamodb_table.connections.name
}

output "table_arn" {
  description = "ARN of the WebSocket connections table."
  value       = aws_dynamodb_table.connections.arn
}

output "gsi_name" {
  description = "Name of the by-cognito-sub GSI the events-pipeline queries."
  value       = "by-cognito-sub"
}
