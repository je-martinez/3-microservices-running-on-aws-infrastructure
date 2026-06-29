variable "spike_backend_port" {
  description = "Port where spike-backend listens inside the Docker compose network. hashicorp/http-echo uses 8080 as configured in docker-compose.yml (via -listen=:8080)."
  type        = number
  default     = 8080
}

variable "nginx_integration_placeholder" {
  description = "Placeholder integration URI used in the initial terraform apply before the Nginx ECS container IP is known. The smoke-test.sh updates the API Gateway integration to the real container IP via the AWS CLI after ECS task launch. Set to 0.0.0.0:80 so the route exists but the placeholder is clearly invalid."
  type        = string
  default     = "0.0.0.0:80"
}
