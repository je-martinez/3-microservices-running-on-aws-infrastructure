# Bucket for public image assets the email templates fetch over plain HTTP —
# clients strip or refuse data: URIs at size, so the templates need a real URL.
#
# WORKAROUND(local): public_read = true only because Floci emulates no
# CloudFront data plane, so reading the bucket directly is the only way to get a
# fetchable URL. Prod keeps the default (false) behind CloudFront + OAC.
# No versioning or lifecycle rules: these objects are derived artifacts that
# `make assets-sync` regenerates. See [[ADR-0017-floci-local]]

locals {
  bucket_name = coalesce(var.bucket_name, "${var.context.id}-assets")
}

resource "aws_s3_bucket" "this" {
  bucket = local.bucket_name

  tags = merge(var.context.tags, { Name = local.bucket_name })
}

# ─── Public-read posture (opt-in) ─────────────────────────────────────────────
# Both resources are gated on the same flag: with public_read = false the bucket
# is left at S3's default (private, account-only), which is what production
# wants behind CloudFront.

# Real S3 refuses a policy granting anonymous access while BlockPublicPolicy is
# on, and would ignore it under RestrictPublicBuckets, so the block has to be
# relaxed FIRST. Floci accepts the call without enforcing it, but the ordering
# is what real AWS requires and this module is not local-only.
resource "aws_s3_bucket_public_access_block" "this" {
  count = var.public_read ? 1 : 0

  bucket = aws_s3_bucket.this.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

# GetObject only. No PutObject, no ListBucket: anonymous callers may fetch an
# asset whose exact key they already know (from the manifest), and nothing else.
resource "aws_s3_bucket_policy" "public_read" {
  count = var.public_read ? 1 : 0

  bucket = aws_s3_bucket.this.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicReadGetObject"
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.this.arn}/*"
    }]
  })

  # The policy must not be applied before the block is relaxed, or real S3
  # rejects it with AccessDenied. Terraform cannot infer this ordering: neither
  # resource references the other, only the bucket.
  depends_on = [aws_s3_bucket_public_access_block.this]
}
