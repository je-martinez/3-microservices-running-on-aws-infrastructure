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
# CONTRACT: NOT a skip-on-record cache — every wrapped script always runs and
# this table only records the outcome. Declared here because this module runs
# first (`make backend-up`) and phase-1 scripts need the table before the
# post-infra root exists. The sort key carries the resource id so a recreated
# resource starts a distinguishable history instead of colliding with the old
# one's records. See [[awscli-fallback-for-floci]]
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
