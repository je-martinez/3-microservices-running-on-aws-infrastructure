variable "environment" {
  description = "Environment name component (label)."
  type        = string
  default     = "local"
}

variable "vpc_cidr" {
  description = "CIDR block for the local VPC."
  type        = string
  default     = "10.0.0.0/16"
}

# NOTE: the networking module takes a richer subnets shape
# (list(object({suffix, cidr, az}))), so main.tf omits this argument and relies
# on that module's own default (2 AZs, 10.0.1.0/24 + 10.0.2.0/24). This variable
# is kept as the declared per-env CIDR intent; wire it into networking by
# reshaping to the module's object type if per-env subnet control is needed.
variable "subnets" {
  description = "Subnet CIDRs for the local VPC (see note above; not yet wired into the module)."
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "db_name" {
  description = "Aurora Postgres database name."
  type        = string
  default     = "users"
}

variable "db_username" {
  description = "Aurora master username."
  type        = string
  default     = "test"
}

variable "db_password" {
  description = "Aurora master password (test default for local Floci)."
  type        = string
  default     = "test"
  sensitive   = true
}
