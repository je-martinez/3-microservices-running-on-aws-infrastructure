locals {
  bucket_name = coalesce(var.bucket_name, "${var.context.id}-state")
  table_name  = coalesce(var.table_name, "${var.context.id}-lock")
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
