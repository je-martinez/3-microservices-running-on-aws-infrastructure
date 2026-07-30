variable "enabled_app_users" {
  description = <<-DESC
    Which engines to manage app-users for. Both engines are enabled: the
    petoju/mysql provider was re-verified against Floci on 2026-07-30 and no
    longer hangs (it created a user + grants in ~10s and a second plan showed
    no drift). The earlier ["postgres"]-only default came from a July limitation
    where `mysql_user` sat at "Still creating..." for minutes and left a
    half-created user needing TLS that Floci does not terminate; that is stale.
  DESC
  type        = list(string)
  default     = ["postgres", "mysql"]
}

variable "pg_port" {
  description = <<-DESC
    Floci RDS-proxy port for the Postgres (Users) cluster. Floci assigns ports
    7000-7099 by cluster CREATION ORDER, which is not stable across applies, so
    this default is only a fallback: `make infra-up-post` discovers the real
    port per-engine (scripts/discover_db_port.py) and passes it as -var.
  DESC
  type        = number
  default     = 7001
}

variable "mysql_port" {
  description = <<-DESC
    Floci RDS-proxy port for the MySQL cluster, shared by Orders and Tracking
    (one cluster, two databases). Same caveat as pg_port: discovered per-engine
    at apply time and passed as -var; this default is only a fallback. It is
    routinely NOT 7002 — a live check on 2026-07-30 saw mysql on 7001 and
    postgres on 7002, i.e. the reverse of these defaults.
  DESC
  type        = number
  default     = 7002
}

variable "pg_database" {
  description = "Postgres (Users) database name."
  type        = string
  default     = "users"
}

variable "mysql_database" {
  description = "MySQL database name for Orders. Same cluster as tracking_database."
  type        = string
  default     = "orders"
}

variable "tracking_database" {
  description = "MySQL database name for Tracking. Same cluster as mysql_database, different schema."
  type        = string
  default     = "tracking"
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
