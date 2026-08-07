output "bucket_name" {
  description = "Name of the assets bucket."
  value       = aws_s3_bucket.this.id
}

output "bucket_arn" {
  description = "ARN of the assets bucket."
  value       = aws_s3_bucket.this.arn
}

output "bucket_regional_domain_name" {
  description = <<-DESC
    The bucket's regional S3 domain. Exposed for a future CloudFront
    distribution, whose origin should be this (NOT the global
    <bucket>.s3.amazonaws.com form, which can 307-redirect on a fresh bucket).
    Against Floci this is a synthesized value and is not fetchable — see
    var.public_read.
  DESC
  value       = aws_s3_bucket.this.bucket_regional_domain_name
}

output "public_base_url" {
  description = <<-DESC
    Base URL an object key is appended to, i.e. "<public_base_url>/<key>". This
    is what the upload script writes into the manifest, so consumers never
    construct S3 URLs themselves.

    Path-style against a custom endpoint (Floci: http://localhost:4566/<bucket>)
    because the emulator serves buckets on its single :4566 port and the
    virtual-host form would need per-bucket DNS. Virtual-host style against real
    AWS, which is the only form S3 still supports for new buckets.

    NOTE for the future prod wiring: once CloudFront fronts this bucket, the
    manifest must be built from the DISTRIBUTION domain, not this value — the
    bucket is private then and this URL returns AccessDenied. Overriding this
    output (or the script's --base-url) is the seam for that.
  DESC
  value       = var.endpoint_url != null ? "${trimsuffix(var.endpoint_url, "/")}/${aws_s3_bucket.this.id}" : "https://${aws_s3_bucket.this.bucket_regional_domain_name}"
}
