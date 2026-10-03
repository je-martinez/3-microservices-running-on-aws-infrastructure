variable "context" {
  type = object({ id = string, tags = map(string) })
}
variable "name" { type = string }
variable "cluster_arn" { type = string }
variable "execution_role_arn" { type = string }
variable "image" { type = string }
variable "cpu" {
  type    = number
  default = 256
}
variable "memory" {
  type    = number
  default = 512
}
variable "container_port" { type = number }
variable "extra_ports" {
  type    = list(number)
  default = []
}
variable "secrets" {
  type        = list(object({ name = string, valueFrom = string }))
  description = "From module.app_config.refs[<svc>]; ECS resolves them at task start."
}
variable "listeners" {
  type = map(object({
    port             = number
    container_port   = number
    protocol_version = optional(string, "HTTP1")
    health_path      = optional(string, "/")
  }))
  default = {}
}
variable "alb_arn" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "security_group_ids" { type = list(string) }
variable "desired_count" {
  type    = number
  default = 1
}
variable "region" { type = string }
