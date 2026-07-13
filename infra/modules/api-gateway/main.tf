# ─── HTTP API ─────────────────────────────────────────────────────────────────
resource "aws_apigatewayv2_api" "this" {
  name          = "${var.context.id}-api"
  protocol_type = "HTTP"
  tags          = var.context.tags
}

# ─── Default stage (auto-deploy) ─────────────────────────────────────────────
#
# auto_deploy = true matches the spike config and eliminates a manual deployment
# step on every route change.  Local invoke URL form:
#   http://<api-id>.execute-api.localhost:4566
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true
  tags        = var.context.tags
}

# ─── JWT Authorizer (Cognito) ─────────────────────────────────────────────────
#
# Issuer must be the AWS-format URL — NOT http://localhost:4566/<pool-id>.
# Ministack validates tokens against the AWS-format issuer even for local stacks.
# Proven in the spike (aws_apigatewayv2_authorizer.spike).
resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.this.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${var.context.id}-jwt"

  jwt_configuration {
    audience = [var.cognito_audience]
    issuer   = var.cognito_issuer
  }
}

# ─── Route table (single source of truth) ────────────────────────────────────
#
# Floci drops the request path in HTTP_PROXY integrations (verified: it parses
# IntegrationUri as a literal URL and ignores $request.path / {proxy}). So in
# local mode we create ONE integration per route with the path baked into the
# URI. Real AWS preserves the path, so prod keeps a single shared integration.
locals {
  routes = merge(
    {
      register = { key = "POST /v1/users/register", path = "/v1/users/register", auth = false }
      login    = { key = "POST /v1/users/login", path = "/v1/users/login", auth = false }
      refresh  = { key = "POST /v1/users/refresh", path = "/v1/users/refresh", auth = false }
      health   = { key = "GET /v1/health", path = "/v1/health", auth = false }
      get_me   = { key = "GET /v1/users/me", path = "/v1/users/me", auth = true }
      patch_me = { key = "PATCH /v1/users/me", path = "/v1/users/me", auth = true }
    },
    var.enable_e2e_cleanup_route ? {
      e2e_cleanup = { key = "DELETE /v1/users/e2e-cleanup", path = "/v1/users/e2e-cleanup", auth = false }
    } : {}
  )
}

# ─── Integrations ─────────────────────────────────────────────────────────────

# LOCAL: one HTTP_PROXY integration per route, path baked into the URI.
resource "aws_apigatewayv2_integration" "per_route" {
  for_each = var.local_gateway ? local.routes : {}

  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  integration_uri        = "${var.nginx_base_uri}${each.value.path}"
  payload_format_version = "1.0"
}

# PROD: single shared HTTP_PROXY integration (real AWS preserves the path).
resource "aws_apigatewayv2_integration" "shared" {
  count = var.local_gateway ? 0 : 1

  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  integration_uri        = var.nginx_integration_uri
  payload_format_version = "1.0"
}

# ─── Routes ───────────────────────────────────────────────────────────────────
resource "aws_apigatewayv2_route" "this" {
  for_each = local.routes

  api_id    = aws_apigatewayv2_api.this.id
  route_key = each.value.key
  target = var.local_gateway ? (
    "integrations/${aws_apigatewayv2_integration.per_route[each.key].id}"
    ) : (
    "integrations/${aws_apigatewayv2_integration.shared[0].id}"
  )

  authorization_type = each.value.auth ? "JWT" : "NONE"
  authorizer_id      = each.value.auth ? aws_apigatewayv2_authorizer.jwt.id : null
}
