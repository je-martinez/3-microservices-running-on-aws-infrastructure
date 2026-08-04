# ─── DocumentDB Subnet Group ────────────────────────────────────────────────────
# Optional: Floci's DocumentDB subnet-group creation fails outright with
# "InvalidClientTokenId: The security token included in the request is
# invalid" (verified 2026-08-03, `make bootstrap`) — unlike rds-aurora's
# quirk, this isn't a tag-read side effect, the create call itself never
# succeeds. Local Floci sets create_subnet_group = false and points the
# cluster at Floci's pre-existing "default" subnet group instead (see
# subnet_group_name below), mirroring the rds-aurora module's toggle.
resource "aws_docdb_subnet_group" "this" {
  count = var.create_subnet_group ? 1 : 0

  name       = "${var.context.id}-docdb-subnet-group"
  subnet_ids = var.subnet_ids

  tags = merge(var.context.tags, { Name = "${var.context.id}-docdb-subnet-group" })
}

# ─── DocumentDB Cluster ──────────────────────────────────────────────────────────
resource "aws_docdb_cluster" "this" {
  cluster_identifier     = "${var.context.id}-docdb"
  engine                 = "docdb"
  engine_version         = var.engine_version
  master_username        = var.master_username
  master_password        = var.master_password
  db_subnet_group_name   = var.create_subnet_group ? aws_docdb_subnet_group.this[0].name : var.subnet_group_name
  vpc_security_group_ids = var.security_group_ids
  skip_final_snapshot    = var.skip_final_snapshot

  tags = merge(var.context.tags, { Name = "${var.context.id}-docdb" })
}

# ─── DocumentDB Instance ─────────────────────────────────────────────────────────
# Floci backs this with a single standalone mongo:7.0 container (no replica set —
# see docs/lessons/floci-sqs-lambda-docdb-support.md, Finding 1: no multi-document
# transactions locally). Real AWS scales this to multiple instances; local stays
# at one, matching what Floci actually emulates.
resource "aws_docdb_cluster_instance" "this" {
  identifier         = "${var.context.id}-docdb-instance"
  cluster_identifier = aws_docdb_cluster.this.id
  instance_class     = var.instance_class
  engine             = "docdb"

  tags = merge(var.context.tags, { Name = "${var.context.id}-docdb-instance" })
}

# ─── Credentials to Parameter Store ──────────────────────────────────────────────
# Per ADR-0007: non-sensitive config (host/port) in Parameter Store; the password
# stays a Terraform-managed sensitive value, never written in plaintext elsewhere.
resource "aws_ssm_parameter" "docdb_host" {
  name  = "/${var.context.id}/docdb/host"
  type  = "String"
  value = aws_docdb_cluster.this.endpoint

  tags = var.context.tags
}

resource "aws_ssm_parameter" "docdb_port" {
  name  = "/${var.context.id}/docdb/port"
  type  = "String"
  value = tostring(aws_docdb_cluster.this.port)

  tags = var.context.tags
}
