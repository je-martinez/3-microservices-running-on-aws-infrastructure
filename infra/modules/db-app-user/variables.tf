variable "context" {
  description = "Naming/tagging context ({id, tags}) from the caller's label module."
  type        = object({ id = string, tags = map(string) })
}

variable "engine" {
  description = "postgres | mysql — selects which provider's resources apply."
  type        = string
  validation {
    condition     = contains(["postgres", "mysql"], var.engine)
    error_message = "engine must be postgres or mysql."
  }
}

variable "database_name" {
  description = "Database the app-user is granted access to."
  type        = string
}

variable "app_username" {
  description = "Login name of the least-privilege application user."
  type        = string
}

variable "master_username" {
  description = "Master/owner username — used as the owner for Postgres default privileges."
  type        = string
}

variable "db_host" {
  description = "DB host recorded in the generated app-credentials secret."
  type        = string
}

variable "db_port" {
  description = "DB port recorded in the generated app-credentials secret."
  type        = number
}
