# Engine-parameterized least-privilege application DB user.
#
# The application user is created WITHOUT the DELETE privilege: this project
# enforces soft-delete only (ADR-0004), so hard DELETE is intentionally
# unavailable and queries always filter `deleted_at IS NULL`. Grants are
# SELECT / INSERT / UPDATE only.
#
# The Postgres branch is the app-user logic extracted from modules/rds-aurora;
# the MySQL branch is its sibling. Only one branch is active per instantiation,
# gated by var.engine (count). The providers are configured by the CALLER (the
# phase-2 post-effects root) against now-live endpoints.
locals {
  is_pg    = var.engine == "postgres"
  is_mysql = var.engine == "mysql"
}

resource "random_password" "app" {
  length  = 24
  special = false
}

# ── Postgres branch ──────────────────────────────────────────────────────────
resource "postgresql_role" "app" {
  count    = local.is_pg ? 1 : 0
  name     = var.app_username
  login    = true
  password = random_password.app.result
}

# CONNECT on the database
resource "postgresql_grant" "connect" {
  count       = local.is_pg ? 1 : 0
  role        = postgresql_role.app[0].name
  database    = var.database_name
  object_type = "database"
  privileges  = ["CONNECT"]
}

# USAGE on schema public
resource "postgresql_grant" "usage" {
  count       = local.is_pg ? 1 : 0
  role        = postgresql_role.app[0].name
  database    = var.database_name
  schema      = "public"
  object_type = "schema"
  privileges  = ["USAGE"]
}

# SELECT, INSERT, UPDATE (NO DELETE) on existing tables
resource "postgresql_grant" "tables" {
  count       = local.is_pg ? 1 : 0
  role        = postgresql_role.app[0].name
  database    = var.database_name
  schema      = "public"
  object_type = "table"
  objects     = [] # all tables in schema
  privileges  = ["SELECT", "INSERT", "UPDATE"]
}

# Default privileges so future tables inherit the same grants (no DELETE)
resource "postgresql_default_privileges" "future_tables" {
  count       = local.is_pg ? 1 : 0
  role        = postgresql_role.app[0].name
  database    = var.database_name
  schema      = "public"
  owner       = var.master_username
  object_type = "table"
  privileges  = ["SELECT", "INSERT", "UPDATE"]
}

# ── MySQL branch (prod only; Floci hangs this — see the Floci MySQL limit) ────
resource "mysql_user" "app" {
  count              = local.is_mysql ? 1 : 0
  user               = var.app_username
  host               = "%"
  plaintext_password = random_password.app.result
}

resource "mysql_grant" "app" {
  count      = local.is_mysql ? 1 : 0
  user       = mysql_user.app[0].user
  host       = mysql_user.app[0].host
  database   = var.database_name
  privileges = ["SELECT", "INSERT", "UPDATE"]
}

# ── Generated app credentials → Secrets Manager (secret-only consumption) ─────
resource "aws_secretsmanager_secret" "app" {
  name        = "${var.context.id}/db-app-user/${var.app_username}"
  description = "Least-privilege app DB credentials for ${var.app_username}"
  tags        = merge(var.context.tags, { Name = "${var.context.id}-${var.app_username}-credentials" })
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    username = var.app_username
    password = random_password.app.result
    host     = var.db_host
    port     = var.db_port
    dbname   = var.database_name
  })
}
