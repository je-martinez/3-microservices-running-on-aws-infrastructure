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

variable "python_bin" {
  description = <<-DESC
    Absolute path to the repo venv's Python interpreter, used by the local-exec
    provisioners. Passed by the Makefile (`-var python_bin=$(PY)`), which owns
    the canonical path; the default is the correct relative depth from THIS
    module for a direct `terraform apply` run by hand. Never plain `python3` —
    a developer's shell may already be inside an unrelated venv, and an apply
    must not silently pick up a stray interpreter.
  DESC
  type        = string
  default     = "../../../../.venv/bin/python"
}
