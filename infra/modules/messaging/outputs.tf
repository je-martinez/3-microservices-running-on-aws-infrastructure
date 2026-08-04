output "queue_url" {
  description = "URL of the main events SQS queue (used by producers)."
  value       = aws_sqs_queue.main.id
}

output "queue_arn" {
  description = "ARN of the main events SQS queue (used by the Lambda event source mapping)."
  value       = aws_sqs_queue.main.arn
}

output "dlq_url" {
  description = "URL of the dead-letter queue."
  value       = aws_sqs_queue.dlq.id
}

output "dlq_arn" {
  description = "ARN of the dead-letter queue."
  value       = aws_sqs_queue.dlq.arn
}
