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
  description = "false = everything except module.service (apply A); true = adds the per-service task definitions, target groups, ALB listeners and ECS services (apply B)."
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

# WHY: Plain bools — they decide which SSM/Secrets entries exist, and for_each keys
# cannot be sensitive. preprod_integrations.py writes all of these to
# integrations.auto.tfvars.json. See [[2026-10-05-preprod-integrations-design]]
variable "stripe_enabled" {
  type    = bool
  default = false
}

variable "geoapify_enabled" {
  type    = bool
  default = false
}

variable "stripe_secret_key_users" {
  type      = string
  default   = ""
  sensitive = true
}

variable "stripe_secret_key_orders" {
  type      = string
  default   = ""
  sensitive = true
}

variable "stripe_webhook_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "stripe_webhook_url_token_users" {
  type      = string
  default   = ""
  sensitive = true
}

variable "stripe_webhook_url_token_orders" {
  type      = string
  default   = ""
  sensitive = true
}

variable "stripe_webhook_allowed_cidrs" {
  type        = string
  default     = ""
  description = "Stripe's webhook IPs plus private ranges; the same list as dev's generate_env_files.py."
}

# WHY: nginx refuses to start with GEOAPIFY_API_KEY undefined, and Secrets Manager
# rejects empty values, so "disabled" is the off state.
variable "geoapify_api_key" {
  type        = string
  default     = "disabled"
  sensitive   = true
  description = "Geoapify key for the web /geocode/ proxy; only used when geoapify_enabled."
}
