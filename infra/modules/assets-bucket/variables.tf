variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "bucket_name" {
  description = <<-DESC
    Override for the bucket name. Defaults to "<context.id>-assets", matching
    how modules/tf-backend derives "<context.id>-state" — the repo's only other
    S3 bucket, and the style reference for this one.
  DESC
  type        = string
  default     = null
}

variable "endpoint_url" {
  description = <<-DESC
    Custom S3 endpoint, when the bucket is served by something other than real
    AWS. Set to "http://localhost:4566" by the local environment so the
    public_base_url output is Floci's PATH-STYLE form
    (http://localhost:4566/<bucket>/<key>) — the emulator serves every bucket on
    its one port, and the virtual-host form would require per-bucket DNS.

    null (the default, and the production value) yields the virtual-host form
    https://<bucket>.s3.<region>.amazonaws.com, which is the only style S3
    supports for new buckets.
  DESC
  type        = string
  default     = null
}

variable "public_read" {
  description = <<-DESC
    Whether every object in this bucket is anonymously readable.

    DEFAULTS TO false (private) ON PURPOSE. The production intent is S3 private
    + CloudFront with an Origin Access Control, so the safe posture must be the
    default: a future prod wiring adds the distribution WITHOUT first having to
    undo a public default that a new environment would otherwise inherit
    silently. Only the local environment opts in, explicitly.

    Why local opts in: Floci does not emulate CloudFront's data plane at all.
    `create-distribution` succeeds, returns a real Id/ARN/DomainName and reports
    Status "Deployed", but the <id>.cloudfront.net domain resolves to nothing
    and serves nothing (curl -> HTTP 000), and there is no local invoke URL to
    point a template at the way API Gateway has /restapis/<id>/... . Floci's own
    docs say it outright: "Actual content delivery is not emulated - this is a
    management-plane-only implementation."
    (https://floci.io/floci/services/cloudfront/, verified 2026-08-06.)

    So locally there is no CDN to front the bucket with, and reading the bucket
    directly is the only option that produces a URL an email client could fetch.
    See docs/lessons/floci-vs-ministack-spike-findings.md.

    When true this module attaches:
      - a public-access block with all four flags OFF (a bucket policy granting
        anonymous s3:GetObject is refused by real S3 while BlockPublicPolicy is
        on), and
      - a bucket policy allowing s3:GetObject to Principal "*" on <bucket>/*.
    Read only. Anonymous writes are never granted, in either posture.
  DESC
  type        = bool
  default     = false
  nullable    = false
}
