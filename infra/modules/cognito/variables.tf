variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "region" {
  description = "AWS region where the User Pool is created. Used to construct the issuer URL."
  type        = string
  default     = "us-east-1"
}

variable "password_minimum_length" {
  description = "Minimum password length enforced by the User Pool."
  type        = number
  default     = 8
}

variable "issuer_style" {
  description = "JWT issuer URL style. 'aws' → https://cognito-idp.<region>.amazonaws.com/<pool-id> (real AWS/Ministack). 'floci' → http://localhost:4566/<pool-id> (Floci local, per floci skill quirk #5)."
  type        = string
  default     = "aws"
  validation {
    condition     = contains(["aws", "floci"], var.issuer_style)
    error_message = "issuer_style must be 'aws' or 'floci'."
  }
}

variable "manage_client_via_provider" {
  description = <<-EOT
    Whether the Cognito App Client is created via the native
    aws_cognito_user_pool_client resource (true, default — real AWS and
    Ministack) or via an AWS CLI local-exec fallback (false — Floci only).

    Floci's CREATE response for this resource includes empty
    AnalyticsConfiguration/RefreshTokenRotation structs, which the AWS
    provider's SDKv2 post-apply consistency check reads as "block count
    changed from 0 to 1" and aborts the apply on creation itself —
    lifecycle.ignore_changes cannot prevent this because it only suppresses
    plan-to-plan diffs, not the provider's internal Create-response
    validation (floci skill, quirk #2, verified empirically).
  EOT
  type        = bool
  default     = true
}

variable "aws_cli_endpoint_url" {
  description = "AWS CLI --endpoint-url override for the manage_client_via_provider = false fallback (e.g. http://localhost:4566 for Floci). Empty string uses the CLI's normal endpoint resolution (AWS_ENDPOINT_URL env var, profile config, or real AWS)."
  type        = string
  default     = ""
}

variable "local_state_dir" {
  description = "Directory where the manage_client_via_provider = false fallback writes/reads the created client's JSON descriptor. Must be writable and stable across applies. Empty string (default) resolves to path.root/.terraform-cognito in main.tf (variable defaults cannot reference path.*). Unused when manage_client_via_provider = true."
  type        = string
  default     = ""
}
