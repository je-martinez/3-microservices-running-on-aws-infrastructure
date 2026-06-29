output "user_pool_id" {
  description = "ID of the Cognito User Pool."
  value       = aws_cognito_user_pool.this.id
}

output "client_id" {
  description = "ID of the Cognito App Client."
  value       = aws_cognito_user_pool_client.this.id
}

output "issuer" {
  description = <<-EOT
    Issuer URL for the JWT authorizer.

    Uses the AWS-format URL (https://cognito-idp.<region>.amazonaws.com/<pool-id>)
    even for local Ministack stacks.  Ministack's JWT authorizer validates tokens
    against this URL — using http://localhost:4566/<pool-id> causes 401 errors.
    This was validated in the spike (infra/environments/local/spike/terraform.tfstate,
    jwt_configuration.issuer field).
  EOT
  value       = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.this.id}"
}
