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

  # Mirror of the app's `users.must_change_password` column, read by the same
  # Pre-Token-Generation V2 Lambda and emitted as a `must_change_password`
  # token claim. Postgres remains the source of truth: Users writes the column
  # and then mirrors it here, so the trigger needs no database access.
  #
  # String, not Boolean: Cognito has no boolean attribute type — the values are
  # the strings "true"/"false", and the Lambda compares against "true".
  # `mutable = true` is load-bearing here in a way it is not for app_user_id:
  # this value genuinely changes over an account's life (set on a forced reset,
  # cleared when the user picks their own password).
  schema {
    name                = "must_change_password"
    attribute_data_type = "String"
    mutable             = true
    string_attribute_constraints {
      min_length = 1
      max_length = 5
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

  # The first three flows are the minimum required for ADMIN_USER_PASSWORD_AUTH
  # (used by CognitoAuthProvider.login) and ALLOW_USER_PASSWORD_AUTH
  # (used by the smoke test / USER_PASSWORD_AUTH flow). ALLOW_CUSTOM_AUTH enables
  # the passwordless email-OTP path: AdminInitiateAuth with AuthFlow=CUSTOM_AUTH,
  # served by the Define/Create/VerifyAuthChallenge triggers below. Native
  # USER_AUTH/EMAIL_OTP is deliberately NOT used — Floci returns tokens for it
  # with no challenge issued at all.
  #
  # NOTE: this whole resource is dead code locally (count = 0 when
  # manage_client_via_provider = false); the local client is created by
  # scripts/create_user_pool_client.py, whose EXPLICIT_AUTH_FLOWS list must stay
  # identical to this one.
  explicit_auth_flows = [
    "ALLOW_ADMIN_USER_PASSWORD_AUTH",
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_CUSTOM_AUTH",
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
# duplicates (see scripts/create_user_pool_client.py). The resulting client id
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
    command     = "${var.python_bin} ${path.module}/scripts/create_user_pool_client.py"
    interpreter = ["/usr/bin/env", "bash", "-c"]
    environment = {
      USER_POOL_ID = self.input.user_pool_id
      CLIENT_NAME  = self.input.client_name
      STATE_FILE   = self.input.state_file
      ENDPOINT_URL = var.aws_cli_endpoint_url
      AWS_REGION   = var.region
      # Traceability only — the script always runs, whatever this records. Empty
      # (the variable's default) means "record nothing", which the script treats
      # as a legitimate state rather than an error.
      EXECUTION_LOG_TABLE = var.execution_log_table
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

  # Silences the AWS SDK v3 maintenance notice, which the runtime writes to
  # stderr and CloudWatch tags ERROR — arriving unclassified in OpenObserve once
  # per cold start. Same fix, same reasoning, as modules/api-gateway-ws and
  # modules/lambda; see the latter's environment block for the full argument.
  environment {
    variables = {
      AWS_SDK_JS_NODE_VERSION_SUPPORT_WARNING_DISABLED = "true"
    }
  }
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
    command     = "${var.python_bin} ${path.module}/scripts/set_pre_token_trigger.py"
    interpreter = ["/usr/bin/env", "bash", "-c"]
    environment = {
      USER_POOL_ID = self.input.user_pool_id
      LAMBDA_ARN   = self.input.lambda_arn
      ENDPOINT_URL = var.aws_cli_endpoint_url
      AWS_REGION   = var.region
      # Traceability only — see terraform_data.client_via_cli above.
      EXECUTION_LOG_TABLE = var.execution_log_table
    }
  }
}

# ─── OTP Challenge Lambda (CUSTOM_AUTH: Define/Create/VerifyAuthChallenge) ────
# ONE Lambda serving all three triggers, dispatched on event.triggerSource — see
# otp-challenge-lambda/index.mjs. Keeping it to one function means one IAM role
# and one log group, and matches pre-token-lambda as the repo's only precedent
# for a Cognito trigger Lambda.
#
# Unlike pre_token (whose role holds NO policies at all — it only reads
# attributes off the trigger event), this role needs sqs:SendMessage:
# CreateAuthChallenge publishes AUTH_OTP_REQUESTED to the shared events queue so
# the events-pipeline Lambda mails the code.
#
# The function has no npm dependencies, so source_dir is zipped as-is (a single
# index.mjs), exactly like pre-token-lambda. The AWS SDK is deliberately NOT
# imported — see that file's header for why an SDK import is unsafe here.
data "archive_file" "otp_challenge" {
  type        = "zip"
  source_dir  = "${path.module}/otp-challenge-lambda"
  output_path = "${path.module}/otp-challenge-lambda.zip"

  # The directory is a pnpm workspace so its tests actually RUN — they existed
  # and nothing invoked them until this was wired up. That brings three files
  # the Lambda must not ship, and `source_dir` zips everything it finds:
  #
  #   - node_modules/ is vitest and its tree. The runtime needs none of it: this
  #     Lambda imports nothing outside node:crypto.
  #   - package.json would make the nodejs runtime treat the directory as a
  #     package and could change how index.mjs resolves.
  #   - the test file is dead weight in a deployed artifact.
  #
  # Excluding them is not only about size. `source_code_hash` is computed from
  # this archive, so without these lines every `pnpm install` that touched the
  # dependency tree would change the hash and Terraform would redeploy a Lambda
  # whose actual code never changed.
  excludes = [
    "node_modules",
    "package.json",
    "index.test.mjs",
  ]
}

resource "aws_iam_role" "otp_challenge" {
  name = "${var.context.id}-otp-challenge-role"
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

# Least privilege: SendMessage on exactly the shared events queue, nothing else.
resource "aws_iam_role_policy" "otp_challenge_sqs" {
  name = "${var.context.id}-otp-challenge-sqs-policy"
  role = aws_iam_role.otp_challenge.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "SqsSendOtpEvents"
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = var.events_queue_arn
    }]
  })
}

resource "aws_lambda_function" "otp_challenge" {
  function_name    = "${var.context.id}-otp-challenge"
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  role             = aws_iam_role.otp_challenge.arn
  filename         = data.archive_file.otp_challenge.output_path
  source_code_hash = data.archive_file.otp_challenge.output_base64sha256
  # CreateAuthChallenge does a synchronous SQS publish before returning, and
  # Cognito fails the whole auth attempt if the trigger times out — 10s leaves
  # room for a cold start plus that call.
  timeout = 10

  # Empty-valued optional keys are DROPPED rather than sent as "". AWS_REGION is
  # a RESERVED Lambda environment key in real AWS — including it at all (even
  # empty) fails a production apply — while locally it must be set, because
  # whether Floci's Lambda containers inject it is unverified and the SigV4
  # signer needs a region. Same reasoning the events-pipeline Lambda applies in
  # environments/local/main.tf. AWS_ENDPOINT_URL is dropped in production so the
  # function falls back to the queue URL's own origin (the real SQS endpoint).
  environment {
    variables = merge(
      {
        EVENTS_QUEUE_URL     = var.events_queue_url
        OTP_CODE_TTL_SECONDS = tostring(var.otp_code_ttl_seconds)
        OTP_CODE_LENGTH      = tostring(var.otp_code_length)
        # Silences the AWS SDK v3 maintenance notice, which the runtime writes to
        # stderr and CloudWatch tags ERROR — arriving unclassified in OpenObserve
        # once per cold start. See modules/lambda's environment block for the
        # full argument, including why the nodejs22.x bump cannot be used here.
        AWS_SDK_JS_NODE_VERSION_SUPPORT_WARNING_DISABLED = "true"
      },
      # Locally the IN-NETWORK name (http://floci:4566): the function runs as a
      # Docker container on 3mrai-network, where localhost is the container.
      var.aws_cli_endpoint_url_in_network != "" ? {
        AWS_ENDPOINT_URL = var.aws_cli_endpoint_url_in_network
      } : {},
      var.lambda_region_env != "" ? { AWS_REGION = var.lambda_region_env } : {},
    )
  }

  tags = var.context.tags
}

resource "aws_lambda_permission" "otp_challenge_cognito" {
  statement_id  = "AllowCognitoInvokeOtpChallenge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.otp_challenge.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.this.arn
}

# Registers all three CUSTOM_AUTH trigger keys in ONE update_user_pool call —
# same awscli-fallback pattern as terraform_data.pre_token_trigger, and for the
# same reason (the pinned provider cannot express these keys usefully alongside
# the V2 pre-token config). Three separate calls would each PUT the whole pool
# and clobber each other's LambdaConfig, which is why one script sets all three.
# depends_on the permission so Cognito may invoke the function once wired.
resource "terraform_data" "auth_challenge_triggers" {
  depends_on = [
    aws_lambda_permission.otp_challenge_cognito,
    # Ordering, not data flow: both scripts read-modify-write the SAME
    # LambdaConfig. Running them concurrently would let one PUT overwrite the
    # other's key, so this one is forced to run AFTER the pre-token wiring and
    # carries it through (see set_auth_challenge_triggers.py).
    terraform_data.pre_token_trigger,
  ]

  input = {
    user_pool_id = aws_cognito_user_pool.this.id
    lambda_arn   = aws_lambda_function.otp_challenge.arn
  }

  provisioner "local-exec" {
    command     = "${var.python_bin} ${path.module}/scripts/set_auth_challenge_triggers.py"
    interpreter = ["/usr/bin/env", "bash", "-c"]
    environment = {
      USER_POOL_ID = self.input.user_pool_id
      # All three keys point at the SAME function — it dispatches internally on
      # event.triggerSource.
      DEFINE_AUTH_CHALLENGE_LAMBDA_ARN          = self.input.lambda_arn
      CREATE_AUTH_CHALLENGE_LAMBDA_ARN          = self.input.lambda_arn
      VERIFY_AUTH_CHALLENGE_RESPONSE_LAMBDA_ARN = self.input.lambda_arn
      ENDPOINT_URL                              = var.aws_cli_endpoint_url
      AWS_REGION                                = var.region
      # Traceability only — see terraform_data.client_via_cli above.
      EXECUTION_LOG_TABLE = var.execution_log_table
    }
  }
}
