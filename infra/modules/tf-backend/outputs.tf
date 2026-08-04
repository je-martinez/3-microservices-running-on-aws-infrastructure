output "bucket_name" {
  description = "Name of the S3 bucket used for Terraform remote state."
  value       = aws_s3_bucket.this.bucket
}

output "lock_table_name" {
  description = "Name of the DynamoDB table used for Terraform state locking."
  value       = aws_dynamodb_table.this.name
}

output "execution_log_table_name" {
  description = "Name of the DynamoDB table used to record provisioning-script execution history."
  value       = aws_dynamodb_table.execution_log.name
}
