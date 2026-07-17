variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "bucket_name" {
  description = "Explicit override for the state bucket name. Defaults to \"<context.id>-state\" when null."
  type        = string
  default     = null
}

variable "table_name" {
  description = "Explicit override for the DynamoDB lock table name. Defaults to \"<context.id>-lock\" when null."
  type        = string
  default     = null
}
