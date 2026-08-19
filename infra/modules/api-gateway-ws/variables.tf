# Same shape as every other module here — a resolved context, not the label
# module's inputs. See infra/modules/docdb/variables.tf.
variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "source_dir" {
  description = "Directory holding the built CJS bundles (functions/realtime-events/dist)."
  type        = string
}

variable "stage_name" {
  description = "WebSocket API stage name."
  type        = string
  default     = "dev"
}

variable "connections_table_name" {
  description = "DynamoDB connections table name."
  type        = string
}

variable "connections_table_arn" {
  description = "DynamoDB connections table ARN, for the handlers' IAM policy."
  type        = string
}

variable "cognito_user_pool_id" {
  description = "Cognito user pool the authorizer validates tokens against."
  type        = string
}

variable "cognito_client_id" {
  description = "Cognito app client id the authorizer validates the audience against."
  type        = string
}

variable "cognito_issuer" {
  description = <<-EOT
    JWT issuer URL the $connect authorizer verifies tokens against, and the
    base of the JWKS URI it fetches (<issuer>/.well-known/jwks.json). Must be
    CONFIGURATION, not derived from cognito_user_pool_id/region inside the
    Lambda: real AWS Cognito's issuer shape
    (https://cognito-idp.<region>.amazonaws.com/<pool-id>) does not hold
    locally — Floci stamps a fixed http://localhost:4566/<pool-id> `iss`
    claim on every token it mints, regardless of which host the calling SDK
    used to reach it. Pass module.cognito.issuer (modules/cognito/outputs.tf)
    — the SAME value the REST API Gateway's native JWT authorizer already
    consumes (modules/api-gateway/main.tf's cognito_issuer), so both
    surfaces agree on one source of truth per environment.
  EOT
  type        = string
}

variable "aws_endpoint_url" {
  description = "Local emulator endpoint for the AWS SDK inside the Lambdas. Empty in production so the SDK resolves the real endpoint."
  type        = string
  default     = ""
}

variable "log_retention_in_days" {
  description = "CloudWatch log retention for the four functions."
  type        = number
  default     = 7
}

variable "environment_variables" {
  description = <<-EOT
    Extra environment variables merged into ALL FOUR functions (authorizer,
    $connect, $disconnect, $default). One map, not four: the four share a
    single Lambda resource declared with for_each, and every consumer so far
    wants the same values on all of them — the OTLP exporter settings, which
    must be configuration rather than code (see [[logging-context]]).

    Merged UNDER the module's own variables, so a caller cannot accidentally
    shadow COGNITO_ISSUER or WS_CONNECTIONS_TABLE with a stale value.
  EOT
  type        = map(string)
  default     = {}
}
