# Same shape as every other module here — a resolved context, not the label
# module's inputs. See infra/modules/docdb/variables.tf.
variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "source_dir" {
  description = "Directory holding the built CJS bundles (functions/realtime-events/dist)."
  type        = string
}

variable "stage_name" {
  description = "WebSocket API stage name."
  type        = string
  default     = "dev"
}

variable "connections_table_name" {
  description = "DynamoDB connections table name."
  type        = string
}

variable "connections_table_arn" {
  description = "DynamoDB connections table ARN, for the handlers' IAM policy."
  type        = string
}

variable "cognito_user_pool_id" {
  description = "Cognito user pool the authorizer validates tokens against."
  type        = string
}

variable "cognito_client_id" {
  description = "Cognito app client id the authorizer validates the audience against."
  type        = string
}

variable "aws_endpoint_url" {
  description = "Local emulator endpoint for the AWS SDK inside the Lambdas. Empty in production so the SDK resolves the real endpoint."
  type        = string
  default     = ""
}

variable "log_retention_in_days" {
  description = "CloudWatch log retention for the four functions."
  type        = number
  default     = 7
}
