variable "enabled_app_users" {
  description = "Which engines to manage app-users for. Local: [\"postgres\"] (Floci hangs mysql). Prod: [\"postgres\",\"mysql\"]."
  type        = list(string)
  default     = ["postgres"]
}

variable "pg_port" {
  description = "Floci RDS-proxy port for the Postgres (Users) cluster."
  type        = number
  default     = 7001
}

variable "mysql_port" {
  description = "Floci RDS-proxy port for the MySQL (Orders) cluster."
  type        = number
  default     = 7002
}

variable "pg_database" {
  description = "Postgres (Users) database name."
  type        = string
  default     = "users"
}

variable "mysql_database" {
  description = "MySQL (Orders) database name."
  type        = string
  default     = "orders"
}

variable "master_username" {
  description = "Master/owner username — owner for Postgres default privileges."
  type        = string
  default     = "test"
}
