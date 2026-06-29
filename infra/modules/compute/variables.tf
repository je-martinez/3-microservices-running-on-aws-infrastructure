variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "vpc_id" {
  description = "VPC ID where the ECS service runs. From networking module output vpc_id."
  type        = string
}

variable "subnet_ids" {
  description = "List of subnet IDs for the ECS service network configuration. From networking module output subnet_ids."
  type        = list(string)
}

variable "security_group_ids" {
  description = "List of security group IDs to attach to the ECS service. From networking module output security_group_ids."
  type        = list(string)
}

# ─── Nginx reverse-proxy config ───────────────────────────────────────────────
# In local/Ministack the app does NOT run in ECS — it runs in the compose
# `<backend_service_name>:watch` container on the same 3mrai-network.  The nginx
# task proxies API Gateway traffic to that compose service by Docker DNS name.
variable "backend_service_name" {
  description = <<-EOT
    Docker Compose service name that nginx will proxy to (e.g. "users").
    nginx resolves this name via Docker's embedded DNS (127.0.0.11 resolver),
    so it must match the service name in docker-compose.yml exactly.
  EOT
  type        = string
}

variable "backend_port" {
  description = "Port the backend service listens on inside the compose network (e.g. 3000)."
  type        = number
  default     = 3000
}

# ─── Task sizing ──────────────────────────────────────────────────────────────
variable "cpu" {
  description = "CPU units for the ECS task definition (1 vCPU = 1024). Minimum for Fargate is 256."
  type        = number
  default     = 256
}

variable "memory" {
  description = "Memory (MiB) for the ECS task definition. Minimum for Fargate is 512."
  type        = number
  default     = 512
}

# ─── CloudWatch ───────────────────────────────────────────────────────────────
variable "log_retention_days" {
  description = "CloudWatch log group retention in days. Use 1 for local/ephemeral environments."
  type        = number
  default     = 1
}

variable "region" {
  description = "AWS region used for CloudWatch log configuration."
  type        = string
  default     = "us-east-1"
}
