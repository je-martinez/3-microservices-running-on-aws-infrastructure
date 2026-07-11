variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

# ─── Cognito JWT authorizer ───────────────────────────────────────────────────
variable "cognito_issuer" {
  description = <<-EOT
    JWT issuer URL for the Cognito authorizer.
    Must use the AWS-format URL:
      https://cognito-idp.<region>.amazonaws.com/<pool-id>
    Ministack validates tokens against this URL even for local stacks.
    Do NOT use http://localhost:4566/<pool-id> — it causes 401 errors.
    Source: cognito module output `issuer`.
  EOT
  type        = string
}

variable "cognito_audience" {
  description = <<-EOT
    JWT audience: the Cognito App Client ID.
    Source: cognito module output `client_id`.
  EOT
  type        = string
}

# ─── nginx integration target ─────────────────────────────────────────────────
#
# Bootstrap requirement (JE-36):
#   The nginx ECS task's private IP is not known until after the task launches.
#   Terraform therefore creates the integration with a placeholder URI and the
#   JE-36 bootstrap script patches it via:
#
#     aws apigatewayv2 update-integration \
#       --api-id <api_id> \
#       --integration-id <integration_id> \
#       --integration-uri "http://<nginx-task-ip>:80/"
#
#   The integration_id output from this module is passed to the bootstrap.
#   This matches the pattern proven in the spike
#   (infra/environments/local/spike/terraform.tfstate, nginx_integration_id
#   output).
variable "nginx_integration_uri" {
  description = <<-EOT
    HTTP URI for the API Gateway → nginx integration.
    Defaults to a placeholder (http://0.0.0.0:80/) that the JE-36 bootstrap
    replaces with the actual nginx ECS task private IP after task launch.
    Format: "http://<nginx-task-private-ip>:80/"
  EOT
  type        = string
  default     = "http://0.0.0.0:80/"
}

# ─── E2E cleanup route ────────────────────────────────────────────────────────
variable "enable_e2e_cleanup_route" {
  description = <<-EOT
    When true, creates the DELETE /v1/users/e2e-cleanup route (no authorizer).
    The service itself returns 404 when E2E_TESTING_ENABLED=false, so this
    route is safe to leave present at the infra level.  Defaults to true.
  EOT
  type        = bool
  default     = true
}

variable "local_gateway" {
  type        = bool
  default     = false
  description = "Local-only: Floci drops the request path in HTTP_PROXY integrations, so create one integration per route with the path baked into the URI. Prod (real AWS) preserves the path with a single shared integration."
}

variable "nginx_base_uri" {
  type        = string
  default     = "http://nginx-stable"
  description = "Local per-route mode base URI: scheme + host, NO trailing slash and NO path. The module appends each route's path (Floci won't forward it). Ignored when local_gateway = false."
}
