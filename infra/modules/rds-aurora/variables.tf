variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "subnet_ids" {
  description = "List of subnet IDs for the DB subnet group."
  type        = list(string)
}

variable "security_group_ids" {
  description = "List of security group IDs to attach to the Aurora cluster."
  type        = list(string)
}

variable "database_name" {
  description = "Name of the initial database created in the Aurora cluster."
  type        = string
  default     = "app"
}

variable "master_username" {
  description = "Master username for the Aurora cluster."
  type        = string
  default     = "postgres"
}

variable "master_password" {
  description = "Master password for the Aurora cluster. Must be provided; do not set a default."
  type        = string
  sensitive   = true
}

variable "create_subnet_group" {
  description = "Create a managed DB subnet group. Default true for real AWS. Set false for Floci local (Floci's ListTagsForResource fails for subnet-group ARNs), and pass subnet_group_name instead."
  type        = bool
  default     = true
}

variable "subnet_group_name" {
  description = "Name of a pre-existing DB subnet group to use when create_subnet_group = false (e.g. Floci's 'default')."
  type        = string
  default     = null
}

variable "engine" {
  description = "DB engine. Default aurora-postgresql for real AWS; local Floci passes 'postgres' (Floci runs real postgres/mysql/mariadb containers, not Aurora)."
  type        = string
  default     = "aurora-postgresql"
}

variable "engine_version" {
  description = "Aurora PostgreSQL engine version."
  type        = string
  default     = "14.6"
}

variable "instance_class" {
  description = "DB instance class for writer and reader instances."
  type        = string
  default     = "db.t3.medium"
}

variable "skip_final_snapshot" {
  description = "Whether to skip the final DB snapshot when the cluster is deleted."
  type        = bool
  default     = true
}

variable "manage_app_user" {
  description = "Create a least-privilege application DB user (SELECT/INSERT/UPDATE, no DELETE) with credentials in Secrets Manager. Default off; envs opt in."
  type        = bool
  default     = false
}

variable "app_username" {
  description = "Name of the least-privilege application DB user."
  type        = string
  default     = "users_app"
}
