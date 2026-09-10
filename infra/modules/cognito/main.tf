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

  # CONTRACT: String, not Boolean — Cognito has no boolean attribute type, so the
  # values are the strings "true"/"false" and the Lambda compares against "true".
  # Keep mutable = true: this flips over an account's life (set on a forced
  # reset, cleared when the user picks their own password). Postgres stays the
  # source of truth; Users mirrors the column here so the trigger needs no DB.
  # See [[cognito-pre-token-lambda]]
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
# CONTRACT: The issuer URL is emulator-specific and selected by var.issuer_style —
# real AWS wants the AWS-format URL, Floci wants http://localhost:4566/<pool-id>.
# WORKAROUND(local): manage_client_via_provider = false. Floci returns
# AnalyticsConfiguration: {} in its CREATE response and the provider's SDKv2
# consistency check reads it as "block count changed from 0 to 1", aborting the
# apply during creation. Do NOT reach for lifecycle.ignore_changes — it only
# suppresses plan diffs, never the provider's Create-response validation. The
# awscli fallback below bypasses the resource lifecycle entirely.
# See [[awscli-fallback-for-floci]]
resource "aws_cognito_user_pool_client" "this" {
  count = var.manage_client_via_provider ? 1 : 0

  name         = "${var.context.id}-client"
  user_pool_id = aws_cognito_user_pool.this.id

  # generate_secret=false: the service uses the public client flow
  generate_secret = false

  # CONTRACT: Keep this list identical to EXPLICIT_AUTH_FLOWS in
  # scripts/create_user_pool_client.py — that script, not this resource, creates
  # the client locally. ALLOW_CUSTOM_AUTH serves the passwordless email-OTP path
  # through the Define/Create/VerifyAuthChallenge triggers below.
  # CONTRACT: Do NOT switch to native USER_AUTH/EMAIL_OTP — Floci returns tokens
  # for it with no challenge issued at all. See [[awscli-fallback-for-floci]]
  explicit_auth_flows = [
    "ALLOW_ADMIN_USER_PASSWORD_AUTH",
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_CUSTOM_AUTH",
  ]

  allowed_oauth_flows_user_pool_client = false

  # WHY: This path is unaffected by the Floci quirk, but a genuine drift of these
  # blocks is safe to ignore here too.
  lifecycle {
    ignore_changes = [analytics_configuration]
  }
}

# ─── Cognito App Client — Floci fallback (bypasses the aws provider) ─────────
# WORKAROUND(local): Creates the client through the AWS CLI, outside Terraform's
# resource lifecycle, so the SDKv2 consistency check above never runs. The script
# reuses an existing client of the same name rather than duplicating it.
# CONTRACT: The client id lands under the ROOT module's directory
# (var.local_state_dir), NOT path.module — module source may be read-only.
# See [[awscli-fallback-for-floci]]
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
# WHY: One Lambda serves all three triggers, dispatched on event.triggerSource.
# Its role needs sqs:SendMessage — CreateAuthChallenge publishes
# AUTH_OTP_REQUESTED so the events-pipeline Lambda mails the code.
# CONTRACT: Do NOT import the AWS SDK in the function — see index.mjs's header.
data "archive_file" "otp_challenge" {
  type        = "zip"
  source_dir  = "${path.module}/otp-challenge-lambda"
  output_path = "${path.module}/otp-challenge-lambda.zip"

  # CONTRACT: Keep these exclusions. The directory is a pnpm workspace so its
  # tests run, and source_dir zips everything it finds — package.json would make
  # the runtime treat the directory as a package and change how index.mjs
  # resolves. source_code_hash is computed from this archive, so without the
  # exclusions every `pnpm install` touching the tree redeploys a Lambda whose
  # code never changed.
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

  # CONTRACT: Drop empty-valued optional keys rather than sending "". AWS_REGION
  # is a RESERVED Lambda environment key in real AWS, so including it even empty
  # fails a production apply; locally it must be set because Floci may not inject
  # it and the SigV4 signer needs a region. AWS_ENDPOINT_URL is dropped in
  # production so the function falls back to the queue URL's own origin.
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
