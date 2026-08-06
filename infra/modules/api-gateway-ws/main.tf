locals {
  base_name = "${var.context.id}-ws"

  # One entry per entrypoint. `route_key` is null for the authorizer, which is
  # not a route.
  functions = {
    authorizer = { route_key = null }
    connect    = { route_key = "$connect" }
    disconnect = { route_key = "$disconnect" }
    default    = { route_key = "$default" }
  }
}

resource "aws_apigatewayv2_api" "this" {
  name                       = local.base_name
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
  tags                       = var.context.tags
}

# One zip per entrypoint: archive_file zips the FILE, so each function gets a
# bare handler .js at the zip root with no package.json beside it — which is
# what makes the nodejs20.x runtime treat it as CommonJS. See the bundling
# constraint in the plan header.
data "archive_file" "fn" {
  for_each    = local.functions
  type        = "zip"
  source_file = "${var.source_dir}/${each.key}.js"
  output_path = "${var.source_dir}/${each.key}.zip"
}

resource "aws_iam_role" "lambda" {
  name = "${local.base_name}-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
  tags = var.context.tags
}

resource "aws_iam_role_policy" "lambda" {
  name = "${local.base_name}-lambda"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
        ]
        Resource = [var.connections_table_arn, "${var.connections_table_arn}/index/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "fn" {
  for_each          = local.functions
  name              = "/aws/lambda/${local.base_name}-${each.key}"
  retention_in_days = var.log_retention_in_days
  tags              = var.context.tags
}

resource "aws_lambda_function" "fn" {
  for_each = local.functions

  function_name    = "${local.base_name}-${each.key}"
  role             = aws_iam_role.lambda.arn
  handler          = "${each.key}.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.fn[each.key].output_path
  source_code_hash = data.archive_file.fn[each.key].output_base64sha256
  timeout          = 10

  environment {
    variables = {
      COGNITO_USER_POOL_ID = var.cognito_user_pool_id
      COGNITO_CLIENT_ID    = var.cognito_client_id
      WS_CONNECTIONS_TABLE = var.connections_table_name
      WS_CONNECTIONS_GSI   = "by-cognito-sub"
      AWS_ENDPOINT_URL     = var.aws_endpoint_url
    }
  }

  depends_on = [aws_cloudwatch_log_group.fn]
  tags       = var.context.tags
}

resource "aws_lambda_permission" "apigw" {
  for_each = local.functions

  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

resource "aws_apigatewayv2_authorizer" "request" {
  api_id          = aws_apigatewayv2_api.this.id
  name            = "${local.base_name}-authorizer"
  authorizer_type = "REQUEST"
  # The token rides in the query string: a browser cannot set headers on a
  # WebSocket handshake, and a POC confirmed no Authorization header reaches
  # the authorizer at all.
  identity_sources                  = ["route.request.querystring.token"]
  authorizer_uri                    = aws_lambda_function.fn["authorizer"].invoke_arn
  authorizer_payload_format_version = "1.0"
}

resource "aws_apigatewayv2_integration" "fn" {
  for_each = { for k, v in local.functions : k => v if v.route_key != null }

  api_id                    = aws_apigatewayv2_api.this.id
  integration_type          = "AWS_PROXY"
  integration_uri           = aws_lambda_function.fn[each.key].invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
}

resource "aws_apigatewayv2_route" "fn" {
  for_each = { for k, v in local.functions : k => v if v.route_key != null }

  api_id    = aws_apigatewayv2_api.this.id
  route_key = each.value.route_key
  target    = "integrations/${aws_apigatewayv2_integration.fn[each.key].id}"

  # Only $connect is authorized — $disconnect and $default run on an
  # already-authorized connection, and API Gateway rejects an authorizer on
  # either of them.
  authorization_type = each.value.route_key == "$connect" ? "CUSTOM" : "NONE"
  authorizer_id      = each.value.route_key == "$connect" ? aws_apigatewayv2_authorizer.request.id : null
}

resource "aws_apigatewayv2_stage" "this" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = var.stage_name
  auto_deploy = true
  tags        = var.context.tags
}
