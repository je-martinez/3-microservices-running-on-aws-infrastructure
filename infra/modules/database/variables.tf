variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "master_username" {
  description = "Master username for the DocumentDB cluster."
  type        = string
  default     = "docdbadmin"
}

variable "master_password" {
  description = "Master password for the DocumentDB cluster. Must be provided; do not set a default."
  type        = string
  sensitive   = true
}

variable "subnet_ids" {
  description = "List of subnet IDs for the DB subnet group."
  type        = list(string)
}

variable "security_group_ids" {
  description = "List of security group IDs to attach to the cluster."
  type        = list(string)
}

variable "instance_class" {
  description = "Instance class for the DocumentDB instance."
  type        = string
  default     = "db.t3.medium"
}

variable "engine_version" {
  description = "DocumentDB engine version. Floci's emulated cluster reports 5.0.0 regardless of what is requested (see docs/lessons/floci-sqs-lambda-docdb-support.md)."
  type        = string
  default     = "5.0.0"
}

variable "skip_final_snapshot" {
  description = "Whether to skip the final snapshot on cluster deletion."
  type        = bool
  default     = true
}
