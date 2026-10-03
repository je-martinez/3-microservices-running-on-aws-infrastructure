variable "environment" {
  type    = string
  default = "preprod"
}

variable "vpc_cidr" {
  type    = string
  default = "10.1.0.0/16"
}

variable "db_username" {
  type    = string
  default = "test"
}

variable "db_password" {
  type      = string
  default   = "test"
  sensitive = true
}

variable "docdb_password" {
  type      = string
  default   = "test"
  sensitive = true
}

variable "ses_from_address" {
  type    = string
  default = "no-reply@3mrai.local"
}

variable "python_bin" {
  type        = string
  description = "Absolute path to the repo venv python (Makefile passes $(PY))."
}

variable "deploy_services" {
  type        = bool
  default     = false
  description = "false = data plane only (apply A); true = ECS services, ALB listeners, gateway (apply B)."
}

variable "image_tags" {
  type        = map(string)
  default     = {}
  description = "service -> immutable tag, written by build_push.py to image-tags.auto.tfvars.json."
}

# WORKAROUND(local): Do NOT default this to true. Floci's ALB does not carry gRPC:
# grpcurl against :9151 fails with 502 "malformed header: missing HTTP content-type"
# while the task container answers directly. See [[2026-10-02-floci-preprod-environment-design]]
variable "users_grpc_via_alb" {
  type        = bool
  default     = false
  description = "false = USERS_GRPC_URL via the Docker alias users-grpc:50051 (preprod_aliases.py attaches it); true = through ALB :9151."
}
