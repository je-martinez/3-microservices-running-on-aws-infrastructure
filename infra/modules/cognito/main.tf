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

  # Stores the app's Prisma user id (usr_…) on the Cognito user. register sets
  # custom:app_user_id at sign-up; a Pre-Token-Generation V2 Lambda copies it
  # into an `app_user_id` token claim. Read/write attributes default to ALL, so
  # no client change is needed. Custom attributes are immutable at the schema
  # level — name/type is a one-way decision (fine locally; Floci re-mints the
  # pool each apply).
  schema {
    name                = "app_user_id"
    attribute_data_type = "String"
    mutable             = true
    string_attribute_constraints {
      min_length = 1
      max_length = 64
    }
  }

  tags = var.context.tags
}

# ─── Cognito App Client ───────────────────────────────────────────────────────
# Auth flows proven in the spike (infra/environments/local/spike/terraform.tfstate).
# The API Gateway JWT authorizer validates tokens issued by this pool/client. The
# issuer URL is emulator-specific (see the `issuer` output and var.issuer_style):
# Ministack/real-AWS want the AWS-format URL; Floci wants http://localhost:4566/<pool-id>
# (floci skill quirk #5). The correct style per environment is selected via issuer_style.
#
# var.manage_client_via_provider gates which implementation creates the client:
# - true (default, prod/Ministack): the native aws_cognito_user_pool_client
#   resource below.
# - false (Floci only): Floci returns AnalyticsConfiguration: {} (and
#   RefreshTokenRotation: {}) in its CREATE response. The AWS provider's SDKv2
#   post-apply consistency check reads that empty struct as "block count
#   changed from 0 to 1" and ABORTS THE APPLY on resource creation itself —
#   this happens before any plan-diff is computed, so `lifecycle.ignore_changes`
#   (which only suppresses diffs between two plans, never the provider's
#   internal Create-response validation) cannot prevent it. Verified empirically
#   (floci skill, quirk #2): a clean `terraform apply` against Floci fails here
#   even with ignore_changes present. The awscli fallback below bypasses the
#   provider's resource lifecycle entirely.
resource "aws_cognito_user_pool_client" "this" {
  count = var.manage_client_via_provider ? 1 : 0

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

  # Kept even though this path is unaffected by the Floci quirk (prod/Ministack
  # only): a genuine future drift of these Floci-only-empty blocks is still
  # safe to ignore here for the same reason the original comment gave.
  lifecycle {
    ignore_changes = [analytics_configuration]
  }
}

# ─── Cognito App Client — Floci fallback (bypasses the aws provider) ─────────
# Only created when var.manage_client_via_provider = false. Creates the client
# via the AWS CLI (a plain SDK call outside Terraform's resource lifecycle, so
# the SDKv2 consistency check above never runs) and idempotently reuses an
# existing client with the same name on re-apply instead of creating
# duplicates (see scripts/create-user-pool-client.sh). The resulting client id
# is written to a JSON file under the ROOT module's working directory
# (var.local_state_dir, default path.root/.terraform-cognito — NOT
# path.module, which points at shared, possibly read-only module source) that
# `data.local_file.client_via_cli` reads back into `output.client_id`.
resource "terraform_data" "client_via_cli" {
  count = var.manage_client_via_provider ? 0 : 1

  input = {
    user_pool_id = aws_cognito_user_pool.this.id
    client_name  = "${var.context.id}-client"
    state_file   = "${var.local_state_dir != "" ? var.local_state_dir : "${path.root}/.terraform-cognito"}/${var.context.id}-client.json"
  }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/create-user-pool-client.sh"
    interpreter = ["/usr/bin/env", "bash"]
    environment = {
      USER_POOL_ID = self.input.user_pool_id
      CLIENT_NAME  = self.input.client_name
      STATE_FILE   = self.input.state_file
      ENDPOINT_URL = var.aws_cli_endpoint_url
      AWS_REGION   = var.region
    }
  }
}

data "local_file" "client_via_cli" {
  count      = var.manage_client_via_provider ? 0 : 1
  filename   = terraform_data.client_via_cli[0].input.state_file
  depends_on = [terraform_data.client_via_cli]
}

# ─── Pre-Token-Generation Lambda (repo's first Lambda) ───────────────────────
# Copies custom:app_user_id into an app_user_id token claim (see
# pre-token-lambda/index.mjs). Bare execution role — no VPC, no DB access, no
# extra policies: the handler only reads attributes off the trigger event.
data "archive_file" "pre_token" {
  type        = "zip"
  source_dir  = "${path.module}/pre-token-lambda"
  output_path = "${path.module}/pre-token-lambda.zip"
}

resource "aws_iam_role" "pre_token" {
  name = "${var.context.id}-pretoken-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = var.context.tags
}

resource "aws_lambda_function" "pre_token" {
  function_name    = "${var.context.id}-pretoken"
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  role             = aws_iam_role.pre_token.arn
  filename         = data.archive_file.pre_token.output_path
  source_code_hash = data.archive_file.pre_token.output_base64sha256
  tags             = var.context.tags
}

resource "aws_lambda_permission" "pre_token_cognito" {
  statement_id  = "AllowCognitoInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.pre_token.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.this.arn
}

# local-only wiring (Floci): the pinned provider can't express the V2
# pre_token_generation_config block, so register the V2 trigger via awscli,
# same pattern as terraform_data.client_via_cli. depends_on the permission so
# Cognito may invoke the function once wired.
resource "terraform_data" "pre_token_trigger" {
  depends_on = [aws_lambda_permission.pre_token_cognito]

  input = {
    user_pool_id = aws_cognito_user_pool.this.id
    lambda_arn   = aws_lambda_function.pre_token.arn
  }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/set-pre-token-trigger.sh"
    interpreter = ["/usr/bin/env", "bash"]
    environment = {
      USER_POOL_ID = self.input.user_pool_id
      LAMBDA_ARN   = self.input.lambda_arn
      ENDPOINT_URL = var.aws_cli_endpoint_url
      AWS_REGION   = var.region
    }
  }
}
