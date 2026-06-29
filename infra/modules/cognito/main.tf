# ─── Cognito User Pool ────────────────────────────────────────────────────────
resource "aws_cognito_user_pool" "this" {
  name = "${var.context.id}-user-pool"

  # Relaxed password policy for local/test environments.
  # Override via var.password_policy for production.
  password_policy {
    minimum_length    = var.password_minimum_length
    require_lowercase = false
    require_numbers   = false
    require_symbols   = false
    require_uppercase = false
  }

  tags = var.context.tags
}

# ─── Cognito App Client ───────────────────────────────────────────────────────
# Auth flows proven in the spike (infra/environments/local/spike/terraform.tfstate).
# The API Gateway JWT authorizer validates tokens issued by this pool/client;
# the issuer must use the AWS-format URL — NOT http://localhost:4566/<pool-id>.
# Ministack accepts the AWS-format issuer even for local stacks.
resource "aws_cognito_user_pool_client" "this" {
  name         = "${var.context.id}-client"
  user_pool_id = aws_cognito_user_pool.this.id

  # generate_secret=false: the service uses the public client flow
  generate_secret = false

  # These three flows are the minimum required for ADMIN_USER_PASSWORD_AUTH
  # (used by CognitoAuthProvider.login) and ALLOW_USER_PASSWORD_AUTH
  # (used by the smoke test / USER_PASSWORD_AUTH flow).
  explicit_auth_flows = [
    "ALLOW_ADMIN_USER_PASSWORD_AUTH",
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  allowed_oauth_flows_user_pool_client = false
}
