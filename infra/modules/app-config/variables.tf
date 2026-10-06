variable "prefix" {
  type        = string
  description = "e.g. 3mrai-preprod → SSM /3mrai-preprod/<svc>/<VAR>, secret 3mrai-preprod/<svc>/<VAR>."
}

variable "parameters" {
  type    = map(map(string))
  default = {}
}

variable "secrets" {
  type      = map(map(string))
  default   = {}
  sensitive = true
}
