output "user_pool_id" {
  description = "ID of the Cognito User Pool."
  value       = aws_cognito_user_pool.this.id
}

output "client_id" {
  description = "ID of the Cognito App Client."
  value = var.manage_client_via_provider ? (
    aws_cognito_user_pool_client.this[0].id
    ) : (
    jsondecode(data.local_file.client_via_cli[0].content).ClientId
  )
}

output "issuer" {
  description = <<-EOT
    Issuer URL for the JWT authorizer. Style is selected via var.issuer_style:

    - "aws" (default): the AWS-format URL
      (https://cognito-idp.<region>.amazonaws.com/<pool-id>). Used for real AWS
      and for Ministack local stacks — Ministack's JWT authorizer validates
      tokens against this URL; http://localhost:4566/<pool-id> causes 401
      errors there. This was validated in the spike
      (infra/environments/local/spike/terraform.tfstate, jwt_configuration.issuer
      field).
    - "floci": http://localhost:4566/<pool-id> — Floci issues tokens with this
      as the `iss` claim, so the authorizer issuer must match it exactly
      (floci skill, quirk #5).
  EOT
  value       = var.issuer_style == "floci" ? "http://localhost:4566/${aws_cognito_user_pool.this.id}" : "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.this.id}"
}
