variable "namespace" {
  description = "Namespace component of the resource name (e.g. project or org short-code)."
  type        = string
  default     = "3mrai"
}

variable "environment" {
  description = "Environment component of the resource name (e.g. local, staging, prod)."
  type        = string
}

variable "stage" {
  description = "Stage component of the resource name (e.g. users, orders). Defaults to empty string."
  type        = string
  default     = ""
}

variable "name" {
  description = "Name component of the resource (e.g. vpc, aurora, cognito)."
  type        = string
}

variable "attributes" {
  description = "Additional name attributes appended after the base name (e.g. writer, reader)."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Additional key/value tags merged into every resource tag map."
  type        = map(string)
  default     = {}
}
