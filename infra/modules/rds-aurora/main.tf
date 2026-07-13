# ─── DB Subnet Group ──────────────────────────────────────────────────────────
# Optional: Floci's ListTagsForResource fails with DBInstanceNotFound for ANY
# DB subnet group ARN (even untagged/default ones), and that tag read is part
# of the Create/Read cycle Terraform runs for this resource — unavoidable while
# it's managed. Local Floci sets create_subnet_group = false and points the
# cluster at Floci's pre-existing "default" subnet group instead (see
# subnet_group_name below).
resource "aws_db_subnet_group" "this" {
  count = var.create_subnet_group ? 1 : 0

  name        = "${var.context.id}-aurora-subnet-group"
  description = "Subnet group for Aurora cluster ${var.context.id}"
  subnet_ids  = var.subnet_ids

  tags = merge(var.context.tags, { Name = "${var.context.id}-aurora-subnet-group" })
}

# ─── Aurora Cluster ───────────────────────────────────────────────────────────
resource "aws_rds_cluster" "this" {
  cluster_identifier = "${var.context.id}-aurora"

  engine         = var.engine
  engine_version = var.engine_version

  database_name   = var.database_name
  master_username = var.master_username
  master_password = var.master_password

  db_subnet_group_name   = var.create_subnet_group ? aws_db_subnet_group.this[0].name : var.subnet_group_name
  vpc_security_group_ids = var.security_group_ids

  # Skip final snapshot for non-production environments; override via var for prod
  skip_final_snapshot = var.skip_final_snapshot

  tags = merge(var.context.tags, { Name = "${var.context.id}-aurora" })

  # `ignore_changes` is a static meta-argument (cannot key off var.engine), so
  # this applies to both engines. It is safe for prod aurora-postgresql too:
  # engine_mode is set once at creation and never legitimately drifts outside
  # Terraform's own config, so ignoring it cannot mask a real misconfiguration.
  #
  # Floci returns engine_mode = "provisioned" on refresh regardless of the
  # requested engine (postgres here is a real, non-Aurora Postgres container),
  # which the AWS provider reads as a change to an Aurora-only attribute and
  # marks `# forces replacement` — destroying/recreating the cluster (and
  # wiping migrated data) on every apply. See docs/lessons/
  # floci-vs-ministack-spike-findings.md for the class of quirk (Floci
  # emulating computed AWS attributes imperfectly).
  lifecycle {
    ignore_changes = [engine_mode]
  }
}

# ─── Writer Instance ──────────────────────────────────────────────────────────
# Cluster instances only apply to Aurora engines; Floci's local "postgres" engine
# runs a real postgres container off the cluster alone (no cluster-instance concept).
resource "aws_rds_cluster_instance" "writer" {
  count = startswith(var.engine, "aurora") ? 1 : 0

  identifier         = "${var.context.id}-aurora-writer"
  cluster_identifier = aws_rds_cluster.this.id
  instance_class     = var.instance_class
  engine             = aws_rds_cluster.this.engine
  engine_version     = aws_rds_cluster.this.engine_version

  tags = merge(var.context.tags, { Name = "${var.context.id}-aurora-writer", Role = "writer" })
}

# ─── Reader Instance ──────────────────────────────────────────────────────────
# ADR-0006: all SELECT queries must use the reader endpoint.
resource "aws_rds_cluster_instance" "reader" {
  count = startswith(var.engine, "aurora") ? 1 : 0

  identifier         = "${var.context.id}-aurora-reader"
  cluster_identifier = aws_rds_cluster.this.id
  instance_class     = var.instance_class
  engine             = aws_rds_cluster.this.engine
  engine_version     = aws_rds_cluster.this.engine_version

  tags = merge(var.context.tags, { Name = "${var.context.id}-aurora-reader", Role = "reader" })
}

# ─── Credentials Secret ───────────────────────────────────────────────────────
# ADR-0007: credentials stored in Secrets Manager; injected at container start.
resource "aws_secretsmanager_secret" "db_credentials" {
  name        = "${var.context.id}/aurora/credentials"
  description = "Aurora master credentials for ${var.context.id}"

  tags = merge(var.context.tags, { Name = "${var.context.id}-aurora-credentials" })
}

resource "aws_secretsmanager_secret_version" "db_credentials" {
  secret_id = aws_secretsmanager_secret.db_credentials.id
  secret_string = jsonencode({
    username = var.master_username
    password = var.master_password
    host     = aws_rds_cluster.this.endpoint
    port     = aws_rds_cluster.this.port
    dbname   = var.database_name
  })
}

# ─── Least-privilege application DB user (gated by manage_app_user) ──────────
# IMPORTANT: The application DB user is created WITHOUT the DELETE privilege.
# This project enforces soft-delete only (ADR-0004); hard DELETE is intentionally
# unavailable so that queries always filter `deleted_at IS NULL`.
#
# Default off (manage_app_user = false); envs opt in once the postgresql
# provider can reach the cluster (see environments/*/providers.tf).
resource "random_password" "app_user" {
  count   = var.manage_app_user ? 1 : 0
  length  = 24
  special = false
}

resource "postgresql_role" "app_user" {
  count    = var.manage_app_user ? 1 : 0
  name     = var.app_username
  login    = true
  password = random_password.app_user[0].result
}

# CONNECT on the database
resource "postgresql_grant" "app_connect" {
  count       = var.manage_app_user ? 1 : 0
  role        = postgresql_role.app_user[0].name
  database    = var.database_name
  object_type = "database"
  privileges  = ["CONNECT"]
}

# USAGE on schema public
resource "postgresql_grant" "app_usage" {
  count       = var.manage_app_user ? 1 : 0
  role        = postgresql_role.app_user[0].name
  database    = var.database_name
  schema      = "public"
  object_type = "schema"
  privileges  = ["USAGE"]
}

# SELECT, INSERT, UPDATE (NO DELETE) on existing tables
resource "postgresql_grant" "app_tables" {
  count       = var.manage_app_user ? 1 : 0
  role        = postgresql_role.app_user[0].name
  database    = var.database_name
  schema      = "public"
  object_type = "table"
  objects     = [] # all tables in schema
  privileges  = ["SELECT", "INSERT", "UPDATE"]
}

# Default privileges so future tables inherit the same grants (no DELETE)
resource "postgresql_default_privileges" "app_future_tables" {
  count       = var.manage_app_user ? 1 : 0
  role        = postgresql_role.app_user[0].name
  database    = var.database_name
  schema      = "public"
  owner       = var.master_username
  object_type = "table"
  privileges  = ["SELECT", "INSERT", "UPDATE"]
}

resource "aws_secretsmanager_secret" "app_credentials" {
  count       = var.manage_app_user ? 1 : 0
  name        = "${var.context.id}/aurora/app-credentials"
  description = "Least-privilege app DB credentials for ${var.context.id}"
  tags        = merge(var.context.tags, { Name = "${var.context.id}-aurora-app-credentials" })
}

resource "aws_secretsmanager_secret_version" "app_credentials" {
  count     = var.manage_app_user ? 1 : 0
  secret_id = aws_secretsmanager_secret.app_credentials[0].id
  secret_string = jsonencode({
    username = var.app_username
    password = random_password.app_user[0].result
    host     = aws_rds_cluster.this.endpoint
    port     = aws_rds_cluster.this.port
    dbname   = var.database_name
  })
}
