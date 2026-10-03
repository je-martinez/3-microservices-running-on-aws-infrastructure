variable "context" {
  type = object({ id = string, tags = map(string) })
}

variable "repositories" {
  type        = set(string)
  description = "Short service names; each becomes <context.id>/<name>."
}
