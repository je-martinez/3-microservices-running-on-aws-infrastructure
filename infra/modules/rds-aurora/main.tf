# ─── DB Subnet Group ──────────────────────────────────────────────────────────
resource "aws_db_subnet_group" "this" {
  name        = "${var.context.id}-aurora-subnet-group"
  description = "Subnet group for Aurora cluster ${var.context.id}"
  subnet_ids  = var.subnet_ids

  tags = merge(var.context.tags, { Name = "${var.context.id}-aurora-subnet-group" })
}

# ─── Aurora Cluster ───────────────────────────────────────────────────────────
resource "aws_rds_cluster" "this" {
  cluster_identifier = "${var.context.id}-aurora"

  engine         = "aurora-postgresql"
  engine_version = var.engine_version

  database_name   = var.database_name
  master_username = var.master_username
  master_password = var.master_password

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = var.security_group_ids

  # Skip final snapshot for non-production environments; override via var for prod
  skip_final_snapshot = var.skip_final_snapshot

  tags = merge(var.context.tags, { Name = "${var.context.id}-aurora" })
}

# ─── Writer Instance ──────────────────────────────────────────────────────────
resource "aws_rds_cluster_instance" "writer" {
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

# ─── In-DB grant note ─────────────────────────────────────────────────────────
# IMPORTANT: The application DB user must be created WITHOUT the DELETE privilege.
# This project enforces soft-delete only (ADR-0004); hard DELETE is intentionally
# unavailable so that queries always filter `deleted_at IS NULL`.
#
# Terraform does NOT manage PostgreSQL in-DB grants.  After `terraform apply`,
# run the following SQL as the master user to create the app user:
#
#   CREATE USER <app_user> WITH PASSWORD '<app_password>';
#   GRANT CONNECT ON DATABASE <dbname> TO <app_user>;
#   GRANT USAGE ON SCHEMA public TO <app_user>;
#   GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO <app_user>;
#   ALTER DEFAULT PRIVILEGES IN SCHEMA public
#     GRANT SELECT, INSERT, UPDATE ON TABLES TO <app_user>;
#   -- NOTE: DELETE is intentionally omitted.
