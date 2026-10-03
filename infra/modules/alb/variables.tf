variable "context" {
  type = object({ id = string, tags = map(string) })
}
variable "subnet_ids" { type = list(string) }
variable "security_group_ids" { type = list(string) }
variable "vpc_id" { type = string }
