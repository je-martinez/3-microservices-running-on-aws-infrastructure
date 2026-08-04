locals {
  bucket_name         = coalesce(var.bucket_name, "${var.context.id}-state")
  table_name          = coalesce(var.table_name, "${var.context.id}-lock")
  execution_log_table = coalesce(var.execution_log_table_name, "${var.context.id}-execution-log")
}

# ─── State Bucket ────────────────────────────────────────────────────────────
# Kept minimal by design: no encryption/lifecycle config beyond versioning
# (Floci support for those extras is limited); prod can extend later.
resource "aws_s3_bucket" "this" {
  bucket = local.bucket_name

  tags = merge(var.context.tags, { Name = local.bucket_name })
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id

  versioning_configuration {
    status = "Enabled"
  }
}

# ─── Lock Table ──────────────────────────────────────────────────────────────
resource "aws_dynamodb_table" "this" {
  name         = local.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  tags = merge(var.context.tags, { Name = local.table_name })
}

# ─── Provisioning Script Execution Log ───────────────────────────────────────
# Traceability for the awscli-fallback local-exec scripts (see
# docs/shared/patterns/awscli-fallback-for-floci.md) — NOT a skip-on-record
# cache. Every wrapped script ALWAYS runs; this table only records the outcome.
# Declared here, next to the lock table, because this module runs first
# (`make backend-up`): phase-1 scripts need the table before the post-infra
# root exists.
# Key: script name (partition) + "<resource_id>#<timestamp>" (sort), so a
# recreated resource (e.g. after `make clean`, which makes Floci mint new ids)
# starts a fresh, distinguishable history instead of colliding with the old
# resource's records.
resource "aws_dynamodb_table" "execution_log" {
  name         = local.execution_log_table
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "script_name"
  range_key    = "run_key"

  attribute {
    name = "script_name"
    type = "S"
  }

  attribute {
    name = "run_key"
    type = "S"
  }

  tags = merge(var.context.tags, { Name = local.execution_log_table })
}
