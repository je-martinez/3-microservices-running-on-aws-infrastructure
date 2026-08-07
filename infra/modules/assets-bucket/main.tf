# Bucket for public image assets (email-template logos today; anything else a
# rendered document must fetch over plain HTTP tomorrow).
#
# WHY A BUCKET AT ALL: email clients will not render a data: URI reliably —
# Outlook and Gmail both strip or refuse them at size — so the templates need a
# real URL. Base64-inlining a 1.4 MB master into every message is worse still.
#
# LOCAL vs PRODUCTION — the difference is expressed, not hidden:
#   local: public_read = true. Floci emulates no CloudFront data plane, so
#          reading the bucket directly is the only way to get a fetchable URL.
#   prod:  public_read stays at its default false, and a later change adds
#          CloudFront + OAC in front of the still-private bucket. That future
#          change is additive; nothing here has to be undone first.
# The full argument lives on var.public_read.
#
# Kept deliberately minimal, same as modules/tf-backend: no versioning,
# encryption or lifecycle rules. These objects are derived artifacts that
# `make assets-sync` can regenerate from assets/ at any time, so versioning
# would only accumulate copies of a file that is already in git.

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
