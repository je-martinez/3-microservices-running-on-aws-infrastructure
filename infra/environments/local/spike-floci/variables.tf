variable "spike_backend_port" {
  description = "Port where spike-backend (hashicorp/http-echo) listens on 3mrai-network."
  type        = number
  default     = 8080
}

variable "nginx_stable_alias" {
  description = "Stable Docker-DNS alias attached to the nginx ECS container by bootstrap.sh after each apply. The API GW integration targets this fixed name so its URI never changes (no docker-inspect/IP patch). This is the 'mock Route53' mechanism: a constant Docker-network alias, since Floci's Route53/Cloud Map do not back DNS resolution for containers."
  type        = string
  default     = "nginx-stable"
}

variable "nginx_stable_ip" {
  description = "Optional fixed IP assigned to the nginx ECS container alongside the alias (same Docker network, outside Docker's auto-assigned range). Empty means alias-only (let Docker keep the auto IP, just add the alias)."
  type        = string
  default     = "192.168.155.20"
}
