# Matches every other module in this repo: modules do NOT instantiate the
# `label` module themselves — they receive an already-resolved context object
# exposing `.id` and `.tags`, and derive names as "${var.context.id}-<suffix>".
# See infra/modules/docdb/variables.tf for the same declaration.
variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "ttl_attribute" {
  description = "Attribute holding the epoch expiry. Safety net only — real cleanup is the 410-Gone path in the events-pipeline."
  type        = string
  default     = "ttl"
}
