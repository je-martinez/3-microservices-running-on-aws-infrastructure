output "function_name" {
  description = "Name of the Lambda function."
  value       = aws_lambda_function.this.function_name
}

output "function_arn" {
  description = "ARN of the Lambda function."
  value       = aws_lambda_function.this.arn
}

output "role_arn" {
  description = "ARN of the Lambda's IAM execution role."
  value       = aws_iam_role.lambda_exec.arn
}

output "event_source_mapping_uuid" {
  description = "UUID of the SQS event source mapping (use with `aws lambda get-event-source-mapping` to assert FunctionResponseTypes)."
  value       = aws_lambda_event_source_mapping.sqs_trigger.uuid
}

output "log_group_name" {
  description = "CloudWatch log group backing the function."
  value       = aws_cloudwatch_log_group.this.name
}

output "function_url" {
  description = "The Function URL, or an empty string when enable_function_url is false."
  value       = var.enable_function_url ? aws_lambda_function_url.this[0].function_url : ""
}
