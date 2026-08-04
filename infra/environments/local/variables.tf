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

variable "docdb_password" {
  description = "Master password for the events-pipeline DocumentDB cluster (test default for local Floci; production supplies it out of band, per ADR-0007)."
  type        = string
  default     = "test"
  sensitive   = true
}

variable "ses_from_address" {
  description = "Verified SES sender identity for events-pipeline emails."
  type        = string
  default     = "no-reply@3mrai.local"
}

variable "execution_log_table" {
  description = <<-DESC
    DynamoDB table where the local-exec provisioning scripts record each run,
    for TRACEABILITY ONLY — never to skip a re-run (see
    infra/scripts/lib3mrai/execution_log.py).

    Created by the `backend/` root (modules/tf-backend), which keeps LOCAL state
    by design and so cannot be read via terraform_remote_state the way phase 1
    is. The name is deterministic — "<label id>-execution-log" for the backend
    root's 3mrai-local-tfstate label — so it is a plain default here, and the
    Makefile exports the same value as EXECUTION_LOG_TABLE for the scripts it
    invokes directly. Confirm it against the backend root's
    execution_log_table_name output.

    Empty string disables recording: the scripts treat an unset table as a
    legitimate state and run exactly as they did before the log existed.
  DESC
  type        = string
  default     = "3mrai-local-tfstate-execution-log"
}
