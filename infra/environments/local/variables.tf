variable "nginx_container_ip" {
  description = <<-EOT
    Private IP of the Nginx ECS container on 3mrai_3mrai-network.
    Not known at plan time — the API Gateway integration is created with a
    placeholder URI (http://0.0.0.0:80/) and patched by bootstrap.sh after
    the ECS task launches.

    The bootstrap script discovers this IP via `docker inspect` and re-runs
    `terraform apply -var nginx_container_ip=<ip>` to patch the integration.

    In production this pattern is not needed; the integration target is a
    stable ALB DNS name (see ADR-0009, ADR-0016).
  EOT
  type        = string
  default     = ""
}

variable "db_master_password" {
  description = <<-EOT
    Master password for the Aurora PostgreSQL cluster.
    Using a fixed test value for local/Ministack environments — secrets do
    not need to be secure locally.  Production uses Secrets Manager rotation
    (ADR-0007).
  EOT
  type        = string
  sensitive   = true
  default     = "localtest123"
}

variable "region" {
  description = "AWS region targeted by this environment."
  type        = string
  default     = "us-east-1"
}
