output "bucket_name" {
  description = "S3 bucket holding Terraform remote state."
  value       = module.tf_backend.bucket_name
}

output "lock_table_name" {
  description = "DynamoDB table for Terraform state locking."
  value       = module.tf_backend.lock_table_name
}
