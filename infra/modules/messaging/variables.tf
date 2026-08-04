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
  description = "SQS visibility timeout for the main queue."
  type        = number
  default     = 30
}

variable "message_retention_seconds" {
  description = "How long SQS retains an undelivered message (main queue)."
  type        = number
  default     = 345600 # 4 days
}
