variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "queue_arn" {
  description = "ARN of the SQS queue this Lambda's event source mapping polls."
  type        = string
}

variable "source_dir" {
  description = "Directory to zip for the Lambda deployment package (the built dist/ output)."
  type        = string
}

variable "handler" {
  description = "Lambda handler entrypoint."
  type        = string
  default     = "dist/handler.handler"
}

variable "runtime" {
  description = "Lambda runtime."
  type        = string
  default     = "nodejs20.x"
}

variable "environment_variables" {
  description = "Environment variables passed to the Lambda function."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "batch_size" {
  description = "Max number of SQS messages per Lambda invocation."
  type        = number
  default     = 10
}

variable "timeout" {
  description = "Lambda function timeout in seconds."
  type        = number
  default     = 30
}

variable "memory_size" {
  description = "Lambda function memory in MB."
  type        = number
  default     = 256
}

variable "log_retention_in_days" {
  description = "CloudWatch log retention for the function's log group."
  type        = number
  default     = 14
}
