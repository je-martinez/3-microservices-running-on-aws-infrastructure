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
  description = <<-DESC
    Lambda handler entrypoint, resolved relative to the ZIP ROOT — not to the
    repo. `archive_file` zips the CONTENTS of var.source_dir, and source_dir is
    already the built `dist/` directory, so `dist/` is NOT a path component
    inside the package: a "dist/handler.handler" default would make the runtime
    look for dist/dist/handler.js and fail with "Cannot find module".
    Same shape as modules/cognito's pre-token Lambda (source_dir =
    pre-token-lambda/, handler = "index.handler").
  DESC
  type        = string
  default     = "handler.handler"
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

# ─── Optional realtime (WebSocket fan-out) grants ───────────────────────────────
# Both default to "" so the module keeps emitting exactly the policy it always
# has when the consumer does not fan out. They are separate variables rather
# than one "extra statements" escape hatch because each one names a concrete
# capability with a concrete resource, which is what keeps the policy reviewable.
variable "ws_connections_table_arn" {
  description = "ARN of the WebSocket connections DynamoDB table. When set, the execution role gains Query on its indexes and DeleteItem on the table (the 410-Gone pruning path). Empty disables the statement."
  type        = string
  default     = ""
}

variable "ws_manage_connections_arn" {
  description = "IAM resource ARN authorizing execute-api:ManageConnections (see modules/api-gateway-ws's manage_connections_arn output). Empty disables the statement."
  type        = string
  default     = ""
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

# ─── Optional Function URL (E2E query route) ───────────────────────────────────
# Default FALSE, and the default is the point: no environment gets a publicly
# reachable HTTPS endpoint on a Lambda unless it asks for one by name.
variable "enable_function_url" {
  description = "Create a public Function URL for this Lambda. Local/E2E only — the events function uses it to serve the E2E email-query route."
  type        = bool
  default     = false
}
