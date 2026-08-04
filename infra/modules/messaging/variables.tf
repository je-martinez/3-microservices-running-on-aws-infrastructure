variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "max_receive_count" {
  description = "Number of deliveries before a message moves to the DLQ."
  type        = number
  default     = 3
}

variable "visibility_timeout_seconds" {
  description = <<-EOT
    SQS visibility timeout for the main queue. MUST stay at least 6x the
    consuming Lambda's timeout (AWS's own guidance for an SQS event source
    mapping): 180 = 6 x the lambda module's 30s default.

    Setting these equal is the trap. A batch that runs the full function
    timeout has its visibility expire at the very moment the function ends, so
    SQS redelivers records the Lambda is still finishing. Local testing cannot
    surface this — batches arrive size-1 and complete in milliseconds — so it
    would first appear in production as a steady trickle of duplicate
    deliveries. The unique index on event_id absorbs most of it, but the window
    between insertStarted and the COMPLETED transition is not idempotent, so a
    concurrent redelivery can reach sendEmail before the first invocation
    finishes and mail the user twice.
  EOT
  type        = number
  default     = 180
}

variable "message_retention_seconds" {
  description = "How long SQS retains an undelivered message (main queue)."
  type        = number
  default     = 345600 # 4 days
}
